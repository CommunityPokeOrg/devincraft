const fs = require('node:fs/promises');
const path = require('node:path');
const Vec3 = require('vec3');

const goalKey = Symbol.for('devincraft.diamond.goal');
const urgentHunger = 6;
const stages = ['survive', 'stock_and_build', 'get_iron', 'smelt_and_equip', 'find_diamonds', 'craft_diamond_set'];
const diamondKit = { diamond_pickaxe: 3, diamond_sword: 2, diamond_helmet: 5, diamond_chestplate: 8, diamond_leggings: 7, diamond_boots: 4 };
const diamondArmor = { head: 'diamond_helmet', torso: 'diamond_chestplate', legs: 'diamond_leggings', feet: 'diamond_boots' };
const netheriteArmor = Object.fromEntries(Object.entries(diamondArmor).map(([slot, name]) =>
    [slot, name.replace('diamond_', 'netherite_')]));
const armorMaterials = ['leather', 'golden', 'chainmail', 'iron', 'diamond', 'netherite'];
const ironArmor = { iron_helmet: 5, iron_chestplate: 8, iron_leggings: 7, iron_boots: 4 };
function armorRank(name, slot) {
    const suffix = diamondArmor[slot].slice('diamond'.length);
    if (slot === 'head' && name === 'turtle_helmet') return armorMaterials.indexOf('iron') + 0.5;
    return name?.endsWith(suffix) ? armorMaterials.indexOf(name.slice(0, -suffix.length)) + 1 : 0;
}
const rawFood = { beef: 'cooked_beef', porkchop: 'cooked_porkchop', mutton: 'cooked_mutton', chicken: 'cooked_chicken' };
const directions = [[1,0], [0,1], [-1,0], [0,-1]];
const air = name => /^(?:air|cave_air|void_air)$/.test(name ?? '');
const terrain = /^(?:stone|dirt|coarse_dirt|grass_block|podzol|moss_block|mud|(?:muddy_)?mangrove_roots|clay|deepslate|andesite|diorite|granite|tuff|calcite|dripstone_block|gravel|sand|(?:deepslate_)?(?:coal|iron|copper|redstone|lapis|gold|diamond|emerald)_ore)$/;
const excavatable = name => terrain.test(name) || name === 'moss_carpet';
const scaffold = /^(?:cobblestone|cobbled_deepslate)$/;
const fluid = /^(?:lava|water|bubble_column)$/;
const ironOre = /^(?:deepslate_)?iron_ore$/;
const coalOre = /^(?:deepslate_)?coal_ore$/;
const diamonds = /^(?:deepslate_)?diamond_ore$/;
const storePath = path.join(__dirname, 'diamond-progress.json');
const stores = globalThis[Symbol.for('devincraft.diamond.stores')] ??= new Map();

function progressStore(file, log) {
    const current = { peakStage: 1, deaths: 0, diamondHighWater: 0, route: null, last: null, stations: {}, smelting: null };
    if (!file) return { current, save() {} };
    if (stores.has(file)) {
        const store = stores.get(file);
        store.current.stations ??= {};
        return store;
    }
    let serial = fs.readFile(file, 'utf8').then(contents => {
        const saved = JSON.parse(contents);
        for (const key of ['peakStage', 'diamondHighWater'])
            current[key] = Math.max(current[key], Number.isSafeInteger(saved[key]) ? saved[key] : 0);
        current.deaths += Number.isSafeInteger(saved.deaths) ? saved.deaths : 0;
        current.last ??= saved.last;
        current.bed ??= saved.bed;
        current.spawnRelocation ??= saved.spawnRelocation;
        current.route ??= saved.route;
        current.stairs ??= saved.stairs;
        current.deathSite ??= saved.deathSite;
        current.woodStocked ??= saved.woodStocked;
        current.tableRecovery ??= saved.tableRecovery;
        current.announcement ??= saved.announcement;
        current.statusLoopEnabled ??= saved.statusLoopEnabled;
        current.stations = { ...saved.stations, ...current.stations };
        current.smelting ??= saved.smelting;
        current.portal ??= saved.portal;
    }).catch(error => { if (error.code !== 'ENOENT') log(`Diamond progress read failed: ${error.code ?? error.name}`); });
    let previous;
    function save() {
        serial = serial.then(async () => {
            const contents = JSON.stringify(current) + '\n';
            if (previous === contents) return;
            const temporary = file + '.tmp';
            await fs.writeFile(temporary, contents, { mode: 0o600 });
            await fs.rename(temporary, file);
            previous = contents;
        }).catch(error => log(`Diamond progress write failed: ${error.code ?? error.name}`));
    }
    const store = { current, save, flush: () => serial };
    stores.set(file, store);
    return store;
}

function assess(items, { alive, safe, food, station, furnace, smelting, safeFood = () => false,
    equippedArmor = {}, dimension, portalReady = false, portalBuilt = false }) {
    const has = name => items.some(i => i.name === name);
    const count = name => items.filter(i => i.name === name).reduce((n, i) => n + i.count, 0);
    const stonePick = items.some(i => /^(?:stone|iron|diamond|netherite)_pickaxe$/.test(i.name));
    const ironPick = items.some(i => /^(?:iron|diamond|netherite)_pickaxe$/.test(i.name));
    const tool = items.some(i => /^(?:stone|iron|diamond|netherite)_sword$/.test(i.name));
    const wood = items.some(i => /_(?:log|planks)$/.test(i.name));
    const reserves = items.some(i => safeFood(i.name) || rawFood[i.name]) || Boolean(smelting && rawFood[smelting]);
    const iron = count('raw_iron') + count('iron_ingot');
    const carried = count('diamond');
    const hasKitItem = name => has(name) || has(name.replace('diamond_', 'netherite_'));
    const crafted = Object.entries(diamondKit).reduce((n, [item, cost]) => n + (hasKitItem(item) ? cost : 0), 0);
    const missingKit = Object.keys(diamondKit).filter(name => !hasKitItem(name));
    const budget = carried + crafted;
    const missingArmor = name => ![name, name.replace('iron_', 'diamond_'), name.replace('iron_', 'netherite_')].some(has);
    const requiredArmor = ironPick && budget < 29 ? ['iron_helmet', 'iron_chestplate'].filter(missingArmor) : [];
    const armorNeeded = requiredArmor.find(name => ironArmor[name] <= iron) ?? requiredArmor[0];
    const spareArmor = ironPick && budget < 29 && (armorNeeded
        ? ironArmor[armorNeeded] <= iron && armorNeeded
        : Object.keys(ironArmor).find(name => ironArmor[name] <= iron && missingArmor(name)));
    let stage, needs;
    if (!alive || !safe || food <= urgentHunger) { stage = 1; needs = ['safe ground and recover health/hunger']; }
    else if (!wood || !station || !furnace || !stonePick || !tool) {
        stage = 2;
        needs = [!wood && 'wood', !station && 'crafting table', !furnace && 'furnace',
            !stonePick && 'stone pickaxe', !tool && 'stone sword or better'].filter(Boolean);
    } else if (!ironPick && iron < 3 && smelting !== 'raw_iron') { stage = 3; needs = [`${3 - iron} more iron for a pickaxe`]; }
    else if (!ironPick || smelting || spareArmor || armorNeeded) {
        stage = 4; needs = [!ironPick && 'smelt iron and craft iron pickaxe', spareArmor && `craft ${spareArmor}`,
            armorNeeded && !spareArmor && `${ironArmor[armorNeeded] - iron} more iron for ${armorNeeded}`,
            'cook raw food when available'].filter(Boolean);
    } else if (budget < 29) { stage = 5; needs = ['descend safely toward Y -58 and mine diamond ore']; }
    else { stage = 6; needs = missingKit; }
    let phase = stages[stage - 1];
    const upgraded = Object.values(netheriteArmor).filter(has).length;
    const equipped = Object.entries(netheriteArmor).filter(([slot, name]) => equippedArmor[slot] === name).length;
    const ready = !missingKit.length && Object.keys(diamondArmor).every(slot =>
        equippedArmor[slot] === diamondArmor[slot] || equippedArmor[slot] === netheriteArmor[slot]
        || (slot === 'feet' && dimension === 'the_nether' && portalBuilt && equippedArmor.feet === 'golden_boots'));
    const obsidian = count('obsidian'), flintAndSteel = has('flint_and_steel');
    const goldArmor = items.some(i => /^golden_(?:helmet|chestplate|leggings|boots)$/.test(i.name));
    const ancientDebris = count('ancient_debris'), scrap = count('netherite_scrap'), ingots = count('netherite_ingot');
    const templates = count('netherite_upgrade_smithing_template');
    const target = Object.keys(netheriteArmor).length;
    if (stage > 1 && ready) {
        if (equipped === target) {
            stage = 10; phase = 'netherite_armor_equipped'; needs = [];
        } else if (upgraded === target || ingots && templates) {
            stage = 9; phase = 'upgrade_armor';
            needs = upgraded === target ? ['equip full netherite armor'] : ['upgrade diamond armor at a smithing table'];
        } else if (dimension === 'the_nether' || ancientDebris || scrap || ingots || templates) {
            stage = 8; phase = 'nether_materials';
            needs = [!templates && 'find a bastion remnant and obtain a netherite upgrade template',
                ancientDebris && 'smelt ancient debris into netherite scrap',
                scrap >= 4 && 'craft netherite ingots from four scrap and four gold ingots',
                scrap + ancientDebris + 4 * (ingots + upgraded) < target * 4 && 'mine ancient debris near Y=15'].filter(Boolean);
        } else {
            stage = 7; phase = 'prepare_nether';
            needs = [!portalReady && obsidian < 14 && 'gather obsidian with a diamond pickaxe',
                !portalReady && !flintAndSteel && 'craft flint and steel', !goldArmor && 'prepare gold armor',
                !reserves && 'stock food', !portalReady && 'build and light a Nether portal near the base',
                'enter the Nether'].filter(Boolean);
        }
    }
    return { stage, phase, needs, wood, reserves, ironPick, iron,
        armorNeeded: armorNeeded ?? null, spareArmor: spareArmor || null,
        complete: !missingKit.length, missingKit,
        netherite: { unlocked: ready, complete: equipped === target, target, upgraded, equipped,
            portalReady, inNether: dimension === 'the_nether', obsidian, flintAndSteel, goldArmor, ancientDebris, scrap, ingots, templates },
        diamonds: { carried, investedInKit: crafted, collected: budget, needed: Math.max(0, 29 - budget), target: 29 } };
}

const neighbors = p => [...directions.map(([x,z]) => p.offset(x,0,z)), p.offset(0,1,0), p.offset(0,-1,0)];
const isFluid = block => fluid.test(block?.name ?? '') || Boolean(block?.getProperties?.().waterlogged);
const dryNeighborhood = (bot, p) => {
    return neighbors(p).every(point => {
        const adjacent = bot.blockAt(point);
        return adjacent && !isFluid(adjacent);
    });
};
const canMine = (bot, block, visible = candidate => bot.canSeeBlock(candidate)) => Boolean(
    block && (excavatable(block.name) || /^(?:obsidian|ancient_debris)$/.test(block.name))
    && !isFluid(block) && bot.canDigBlock(block) && visible(block)
    && dryNeighborhood(bot, block.position));
const stairFloor = block => block?.boundingBox === 'block' && !isFluid(block)
    && (terrain.test(block.name) || scaffold.test(block.name));
const dryStair = (bot, point) => [2, 1, 0].every(y => {
    const position = point.offset(0,y,0);
    const block = bot.blockAt(position);
    return block && !isFluid(block) && dryNeighborhood(bot, position);
});
const staircaseStepOpen = (bot, point) => stairFloor(bot.blockAt(point.offset(0,-1,0)))
    && dryStair(bot, point) && [2, 1, 0].every(y => air(bot.blockAt(point.offset(0,y,0))?.name));

function detourColumn(bot, point) {
    if (!stairFloor(bot.blockAt(point.offset(0,-1,0)))) return;
    const blocks = [1,0].map(y => bot.blockAt(point.offset(0,y,0)));
    if (!blocks.every(b => b && !isFluid(b) && (air(b.name) || excavatable(b.name)) && dryNeighborhood(bot, b.position))) return;
    return { point, block: blocks.find(b => !air(b.name)) };
}

function levelDetour(bot, origin, visible, available) {
    let longest;
    const prospect = { blockAt: p => bot.blockAt(p), canDigBlock: b => b.diggable };
    for (const [x,z] of directions) {
        for (let length = 1; length <= 15; length++) {
            const point = origin.offset(x*length,0,z*length);
            if (!available(point)) break;
            const step = detourColumn(bot, point);
            if (!step || length === 1 && step.block && !canMine(bot, step.block, visible)) break;
            if (length < 5) continue;
            const candidate = { target: point, direction: new Vec3(x,0,z), length };
            if (tunnelPlan(prospect, point.y - 1, null, () => true, available, false, point)) return candidate;
            if (!longest || length > longest.length) longest = candidate;
        }
    }
    return longest;
}

function tunnelPlan(bot, floorY, route, visible = block => bot.canSeeBlock(block), available = () => true, canScaffold = false,
    origin = bot.entity.position.floored()) {
    const column = (point, descending, bridge = false) => {
        if (!available(point)) return;
        const floor = bot.blockAt(point.offset(0,-1,0));
        if (!floor) return;
        const points = [point.offset(0,1,0), point];
        if (descending) points.unshift(point.offset(0,2,0));
        const blocks = points.map(p => bot.blockAt(p));
        if (bridge) {
            if (!air(floor.name) || !blocks.every(b => air(b?.name)) || !dryNeighborhood(bot, floor.position)) return;
            const reference = [floor.position.offset(0,-1,0), ...directions.map(([x,z]) => floor.position.offset(x,0,z))]
                .map(p => bot.blockAt(p)).find(b => b?.boundingBox === 'block'
                    && (terrain.test(b.name) || scaffold.test(b.name)) && bot.canDigBlock(b) && visible(b));
            if (reference) return { point, scaffold: { reference, face: floor.position.minus(reference.position) } };
            return;
        }
        if (!stairFloor(floor)) return;
        if (!blocks.every(b => b && !isFluid(b) && (air(b.name) || excavatable(b.name)))) return;
        if (descending && !dryStair(bot, point)) return;
        const first = blocks.find(b => !air(b.name));
        if (first && !canMine(bot,first,visible)) return;
        return { point, block: blocks.find(b => !air(b.name)) };
    };
    const heading = route?.heading ?? 0;
    if (origin.y > floorY) {
        for (const bridge of canScaffold ? [false, true] : [false]) {
            for (let i = 0; i < 4; i++) {
                const direction = (heading + i) % 4;
                const [x,z] = directions[direction];
                const next = column(origin.offset(x,-1,z), true, bridge);
                if (next) return { ...next, route: { heading: direction, spine: 0, branch: 0, returnTo: null } };
            }
        }
        if (canScaffold) {
            for (let i = 0; i < 4; i++) {
                const [x,z] = directions[(heading + i) % 4];
                const point = origin.offset(x,-1,z);
                if (!available(point)) continue;
                const exposed = [point, point.offset(0,1,0), point.offset(0,2,0)]
                    .flatMap(pos => [pos, ...neighbors(pos)])
                    .map(pos => bot.blockAt(pos))
                    .filter(block => block && /^(?:lava|water)$/.test(block.name)
                        && origin.distanceTo(block.position) <= 4 && visible(block));
                for (const fluid of exposed) {
                    const reference = neighbors(fluid.position).map(pos => bot.blockAt(pos)).find(block =>
                        stairFloor(block) && visible(block));
                    if (reference) return { point, scaffold: { reference, face: fluid.position.minus(reference.position), seal: fluid.name } };
                }
            }
        }
        return;
    }
    const nextRoute = { heading, spine: route?.spine ?? 0, branch: route?.branch ?? 0, returnTo: route?.returnTo ?? null };
    if (nextRoute.returnTo && route?.branchHeading !== undefined) nextRoute.branchHeading = route.branchHeading;
    if (nextRoute.returnTo && nextRoute.branch >= 12) {
        const [x,y,z] = nextRoute.returnTo;
        const point = new Vec3(x,y,z);
        nextRoute.returnTo = null;
        nextRoute.branch = 0;
        delete nextRoute.branchHeading;
        nextRoute.lastBranch = nextRoute.spine;
        if (!origin.equals(point)) return available(point) ? { point, route: nextRoute } : undefined;
    }
    let side = nextRoute.returnTo || nextRoute.spine > 0 && nextRoute.spine % 3 === 0 && nextRoute.branch === 0
        && (nextRoute.lastBranch ?? route?.lastBranch) !== nextRoute.spine;
    const forward = direction => column(origin.offset(directions[direction][0],0,directions[direction][1]), false);
    const branchTurn = Math.floor(nextRoute.spine / 3) % 2 ? 1 : 3;
    let next = forward(side ? nextRoute.branchHeading ?? (heading + branchTurn) % 4 : heading);
    if (!next && side) {
        if (nextRoute.returnTo) {
            const [x,y,z] = nextRoute.returnTo;
            const point = new Vec3(x,y,z);
            if (!available(point)) return;
            return { point, route: { heading, spine: nextRoute.spine, branch: 0, returnTo: null, lastBranch: nextRoute.spine } };
        }
        next = forward((heading + 4 - branchTurn) % 4);
        if (next) nextRoute.branchHeading = (heading + 4 - branchTurn) % 4;
        else { side = false; next = forward(heading); }
    }
    if (!next) return;
    if (side) {
        nextRoute.returnTo ??= [origin.x,origin.y,origin.z];
        nextRoute.branch++;
        nextRoute.lastBranch = nextRoute.spine;
    } else {
        nextRoute.spine++;
        nextRoute.lastBranch = route?.lastBranch;
    }
    return { ...next, route: nextRoute };
}

function attachDiamond(bot, safeFood, { file = bot._client?.socket ? storePath : undefined, log = () => {} } = {}) {
    const store = progressStore(file, log);
    let lastAt = 0, blockers = [], current, lastPosition;
    const point = data => data && data.dimension === bot.game?.dimension ? new Vec3(data.x, data.y, data.z) : undefined;
    function snapshot({ safe = true, station = false, furnace = false, healthReady = bot.health > 10 } = {}) {
        if (bot.entity?.position && bot.health > 0) {
            const { x, y, z } = bot.entity.position;
            lastPosition = { x, y, z, dimension: bot.game?.dimension };
        }
        const items = [...new Set([...(bot.inventory?.items() ?? []), ...(bot.inventory?.slots?.slice(5,9).filter(Boolean) ?? [])])];
        const tablePoint = point(store.current.stations.crafting_table);
        const table = tablePoint && bot.blockAt?.(tablePoint);
        const equippedArmor = Object.fromEntries(Object.keys(diamondArmor).map(slot =>
            [slot, bot.inventory?.slots?.[bot.getEquipmentDestSlot?.(slot)]?.name ?? null]));
        const portal = point(store.current.portal);
        const result = assess(items, { alive: healthReady, safe, food: bot.food ?? 0,
            station: station || Boolean(tablePoint && (!table || table.name === 'crafting_table')) || items.some(i => i.name === 'crafting_table'),
            furnace: furnace || items.some(i => i.name === 'furnace'),
            smelting: point(store.current.smelting) ? store.current.smelting.input : undefined,
            safeFood: name => safeFood(bot, name), equippedArmor, dimension: bot.game?.dimension,
            portalBuilt: Boolean(store.current.portal),
            portalReady: Boolean(portal && bot.blockAt?.(portal)?.name === 'nether_portal') });
        const persistent = store.current;
        persistent.peakStage = Math.max(persistent.peakStage, result.stage);
        persistent.diamondHighWater = Math.max(persistent.diamondHighWater, result.diamonds.collected);
        current = { ...result, diamonds: { ...result.diamonds, highWater: persistent.diamondHighWater },
            peakStage: persistent.peakStage, deaths: persistent.deaths, y: bot.entity?.position.y ?? null,
            dimension: bot.game?.dimension ?? null, blockers, equippedArmor, bed: persistent.bed ?? null,
            spawnRelocation: persistent.spawnRelocation ?? null };
        if (Date.now() - lastAt > 2000) {
            lastAt = Date.now();
            persistent.last = current;
            store.save();
        }
        return current;
    }
    const death = () => {
        store.current.deaths++;
        store.current.deathSite = (bot.entity?.position || lastPosition) ? {
            ...(bot.entity?.position ? { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z,
                dimension: bot.game?.dimension } : lastPosition), at: Date.now(),
        } : null;
        store.current.route = null;
        store.current.stairs = null;
        store.current.smelting = null;
        store.current.woodStocked = false;
        store.current.tableRecovery = null;
        current = undefined;
        store.save();
    };
    bot.on('death', death);
    const handle = {
        status: () => current ?? snapshot(),
        snapshot,
        blocked: reason => { blockers = reason ? [reason] : []; if (current) current.blockers = blockers; },
        route: () => store.current.route,
        previousStair: position => {
            const trail = store.current.stairs;
            if (trail?.dimension !== bot.game?.dimension || !trail) return;
            const index = trail.cells.findIndex(([x,y,z]) => position.x === x && position.y === y && position.z === z);
            if (index > 0) return new Vec3(...trail.cells[index - 1]);
        },
        recordStair: (from, to) => {
            const dimension = bot.game?.dimension;
            const trail = store.current.stairs;
            const same = (cell, point) => cell[0] === point.x && cell[1] === point.y && cell[2] === point.z;
            const cells = trail?.dimension === dimension && trail ? trail.cells : [];
            const start = cells.findIndex(cell => same(cell, from));
            const previous = start < 0 ? [[from.x, from.y, from.z]] : cells.slice(0, start + 1);
            const loop = previous.findIndex(cell => same(cell, to));
            store.current.stairs = { dimension, cells: loop < 0
                ? [...previous, [to.x, to.y, to.z]].slice(-512) : previous.slice(0, loop + 1) };
        },
        deathSite: () => store.current.deathSite,
        bed: () => store.current.bed,
        setBed: bed => { store.current.bed = bed; store.save(); },
        spawnRelocation: () => store.current.spawnRelocation,
        setSpawnRelocation: relocation => { store.current.spawnRelocation = relocation; store.save(); },
        finishDeathRecovery: () => { store.current.deathSite = null; store.save(); },
        advance: route => { if (route) { store.current.route = route; store.save(); } },
        woodStocked: mark => {
            if (mark && !store.current.woodStocked) { store.current.woodStocked = true; store.save(); }
            return Boolean(store.current.woodStocked);
        },
        tableRecovery: () => store.current.tableRecovery,
        setTableRecovery: recovery => { store.current.tableRecovery = recovery; store.save(); },
        announcement: () => store.current.announcement,
        announce: value => { store.current.announcement = value; store.save(); },
        statusLoopEnabled: () => store.current.statusLoopEnabled !== false,
        setStatusLoop: enabled => { store.current.statusLoopEnabled = enabled; store.save(); return { enabled }; },
        stations: () => ({ stationPoint: point(store.current.stations.crafting_table), furnacePoint: point(store.current.stations.furnace) }),
        station: (name, pos) => {
            if (pos) store.current.stations[name] = { x: pos.x, y: pos.y, z: pos.z, dimension: bot.game?.dimension };
            else delete store.current.stations[name];
            store.save();
        },
        smeltPoint: () => point(store.current.smelting),
        portal: () => store.current.portal,
        setPortal: portal => { store.current.portal = portal; store.save(); },
        smelting: (pos, input) => {
            store.current.smelting = pos && input ? { x: pos.x, y: pos.y, z: pos.z, dimension: bot.game?.dimension, input } : null;
            store.save();
        },
        flush: store.flush,
        close: () => { bot.off('death', death); if (bot[goalKey] === handle) delete bot[goalKey]; },
    };
    bot[goalKey] = handle;
    return handle;
}

module.exports = { armorRank, assess, attachDiamond, canMine, coalOre, detourColumn, diamondArmor, diamondKit, diamonds, dryNeighborhood,
    ironArmor, ironOre, levelDetour, rawFood, staircaseStepOpen, tunnelPlan, urgentHunger };
