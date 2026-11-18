const { Worker } = require('node:worker_threads');
const { performance } = require('node:perf_hooks');
const { setTimeout: wait } = require('node:timers/promises');
const path = require('node:path');
const Vec3 = require('vec3');
const { goals } = require('mineflayer-pathfinder');
let meleeTiming;
try {
    const { MaxDamageOffset } = require('mineflayer-pvp');
    meleeTiming = new MaxDamageOffset(0, 1);
} catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
}
const { climbPillar } = require('./pillar.cjs');
const { bestWeapon, createFoodRecovery, safeFood, sheepHuntSafe } = require('./food-recovery.cjs');
delete require.cache[require.resolve('./diamond-goal.cjs')];
const { armorRank, attachDiamond, canMine, coalOre, detourColumn, diamondArmor, diamonds, dryNeighborhood, ironArmor, ironOre, levelDetour, rawFood,
    staircaseStepOpen, tunnelPlan, urgentHunger } = require('./diamond-goal.cjs');
delete require.cache[require.resolve('./status-loop.cjs')];
const { createStatusTicker } = require('./status-loop.cjs');

const air = block => Boolean(block && /^(air|cave_air|void_air)$/.test(block.name));
const woodTrail = block => air(block) || /^(?:vine|short_grass|tall_grass|fern|large_fern|mangrove_propagule|moss_carpet)$/.test(block?.name ?? '');
const hazard = block => /(?:magma|campfire|fire|cactus|berry_bush|powder_snow|portal)/.test(block.name);
const logName = name => /^(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak)_log$/.test(name);
const natural = /^(?:air|cave_air|void_air|water|grass_block|dirt|podzol|mycelium|mud|clay|sand|gravel|stone|deepslate|bedrock|short_grass|tall_grass|fern|large_fern|vine|moss_block|moss_carpet|.*_log|.*_leaves|mangrove_roots|muddy_mangrove_roots|mangrove_propagule)$/;
const coords = pos => ({ x: pos.x, y: pos.y, z: pos.z });
const toVec = ({ x, y, z }) => new Vec3(x, y, z);
const ground = /^(?:grass_block|dirt|coarse_dirt|podzol|mud|sand|gravel|clay|stone|deepslate|moss_block)$/;
const diggableGround = /^(?:grass_block|dirt|coarse_dirt|podzol|mud|stone|deepslate)$/;
const buildingBlock = /^(?:\w+_planks|dirt|cobblestone|cobbled_deepslate|mud)$/;
const offsets = [[1,0], [-1,0], [0,1], [0,-1], [1,1], [1,-1], [-1,1], [-1,-1]];
const stationFaces = [new Vec3(0,1,0), ...offsets.slice(0,4).map(([x,z]) => new Vec3(x,0,z)), new Vec3(0,-1,0)];
const stationSoil = /^(?:grass_block|dirt|coarse_dirt|podzol|moss_block|mud|clay|(?:muddy_)?mangrove_roots)$/;
const workstationName = /^(?:crafting_table|furnace)$/;
const stationSupport = block => block?.boundingBox === 'block' && !hazard(block)
    && (block.name === 'mud' || !block.shapes || block.shapes.some(shape => shape.every((value, i) => value === (i < 3 ? 0 : 1))));
const ranged = /skeleton|stray|bogged|pillager|witch|blaze|ghast/;
const archer = /^(?:skeleton|stray|bogged)$/;
const meleePursuer = /^(?:zombie|husk|drowned|spider|cave_spider)$/;
const meleeThreat = entity => entity.name !== 'creeper' && !ranged.test(entity.name);
const volatile = /creeper|warden|ravager|ghast|enderman/;
const interval = 500;
const bedSearchTimeout = 10 * 60_000;
const fleeLimit = 15_000;
const threatPause = 5000;
const pursuitRetry = 30_000;
const hitReach = 2.9;
const walkStall = 3000;
const forestLimit = 300;
const forestLog = /^(?:oak|birch|spruce|dark_oak|jungle)_log$/;
const forestBiome = /(?:forest|taiga|jungle|grove|wooded_badlands)/;
const pickTier = name => ['wooden', 'stone', 'iron', 'diamond', 'netherite'].indexOf(name.split('_')[0]) + 1;
const scaffoldMaterial = /^(?:cobblestone|cobbled_deepslate|dirt|andesite|diorite|granite|stone)$/;
const ascentRock = /^(?:stone|deepslate|dirt|grass_block|mud|clay|andesite|diorite|granite|tuff|calcite|dripstone_block|cobblestone|cobbled_deepslate)$/;
const fallingBlock = /^(?:gravel|(?:red_)?sand|.+_concrete_powder)$/;
const workstationRoute = /^walk_to_(?:table|furnace)$/;
const workstationStep = /^walk_(?:up|level)_step$/;
const tableAttemptMs = 120_000;
const deathRecoveryMs = 240_000;
const deathRecoveryRange = 96;
const reserveWood = 8;
const deepSticks = 16;
const deepLogs = 3;
const deepCobble = 32;
const ironSearchY = 16;
const cobbleMaterial = /^(?:cobblestone|cobbled_deepslate)$/;
const defenseReserve = /^(?:dirt|cobblestone|cobbled_deepslate)$/;
const reserveSoil = /^(?:grass_block|dirt|podzol|mycelium)$/;
const defenseBlocks = 16;
const spawnEscapeRange = 150;
const spawnRadius = 48;
const spawnStallWindow = 90_000;
const spawnDeathWindow = 30 * 60_000;
const dryBaseSoil = /^(?:grass_block|dirt|coarse_dirt|podzol|mycelium|moss_block)$/;
const horizontal = (a,b) => Math.hypot(a.x - b.x, a.z - b.z);
const woolName = /^(\w+)_wool$/;
const bedName = /^\w+_bed$/;
const sheepColors = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray',
    'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black'];
const countLogs = items => items.reduce((n, item) => n + (logName(item.name) ? item.count : 0), 0);
const countPlanks = items => items.reduce((n, item) => n + (item.name.endsWith('_planks') ? item.count : 0), 0);
const woodUnits = items => countPlanks(items) + 4 * countLogs(items);
const craftingWoodCost = { crafting_table: 4, shield: 6, stick: 2, wooden_pickaxe: 3, wooden_sword: 2 };

function walkStaircase(bot, setWalking, goal, ascent, upOnly = false, safeStep) {
    setWalking(bot);
    const movement = bot.pathfinder.movements;
    movement.maxDropDown = upOnly ? 1 : 2; // Pathfinder counts from the starting feet to the landing floor.
    movement.infiniteLiquidDropdownDistance = false;
    if (ascent) {
        movement.canDig = true;
        movement.allow1by1towers = true;
        movement.scafoldingBlocks = [...new Set((bot.inventory.items() ?? []).filter(item => scaffoldMaterial.test(item.name))
            .map(item => bot.registry.itemsByName[item.name]?.id).filter(id => id !== undefined))];
        movement.exclusionAreasBreak?.push(block => ascent(block) ? 0 : 100);
    }
    if (safeStep) movement.exclusionAreasStep?.push(block => block.position && safeStep(block.position) ? 0 : 100);
    bot.pathfinder.setGoal(goal);
}

function lineClear(bot, from, to) {
    const delta = to.minus(from);
    const distance = delta.norm();
    return !distance || !bot.world?.raycast?.(from, delta.normalize(), distance);
}

function threatMode(threats, health) {
    if (threats.some(e => e.name === 'creeper')) return 'flee';
    const melee = threats.filter(meleeThreat).length;
    if (melee && (health <= 8 || melee >= 2)) return 'shelter';
    return !melee && health <= 10 ? 'cover' : 'fight';
}

function gearPlan(items, { furnaceReady = true, woodPickFirst = false } = {}) {
    const count = pattern => items.filter(i => pattern.test(i.name)).reduce((sum, i) => sum + i.count, 0);
    const tier = suffix => items.some(i => new RegExp(`^(stone|iron|diamond|netherite)_${suffix}$`).test(i.name));
    const pick = items.some(i => i.name.endsWith('_pickaxe'));
    const weapon = bestWeapon(items);
    const stone = count(/^(?:cobblestone|cobbled_deepslate|blackstone)$/);
    const upgraded = tier('pickaxe') && tier('sword');
    if (upgraded) {
        if (furnaceReady) return null;
        if (stone < 8) return { mine: true };
        if (count(/^crafting_table$/)) return { tool: 'furnace' };
    }
    const tool = upgraded ? 'furnace' : !pick ? (!woodPickFirst && stone >= 3 ? 'stone_pickaxe' : 'wooden_pickaxe')
        : !weapon ? (stone >= 2 ? 'stone_sword' : 'wooden_sword')
            : !tier('pickaxe') ? (stone >= 3 ? 'stone_pickaxe' : null)
                : stone >= 2 ? 'stone_sword' : null;
    if (!tool) return { mine: true };
    if (!count(/^crafting_table$/) && count(/_planks$/) >= 4) return { craft: 'crafting_table' };
    const sticks = tool === 'furnace' ? 0 : tool.endsWith('pickaxe') ? 2 : 1;
    if (count(/^stick$/) < sticks && count(/_planks$/) >= 2) return { craft: 'stick' };
    const wood = tool.startsWith('wooden') ? tool.endsWith('pickaxe') ? 3 : 2 : 0;
    if (!count(/^crafting_table$/) || count(/^stick$/) < sticks || count(/_planks$/) < wood) {
        const log = items.find(i => logName(i.name));
        return log ? { craft: log.name.replace(/_log$/, '_planks') } : { wood: true };
    }
    return { tool };
}

function recoveryFood(bot) {
    return (bot.inventory?.items() ?? [])
        .filter(item => safeFood(bot, item.name))
        .sort((a, b) => bot.registry.foodsByName[b.name].effectiveQuality - bot.registry.foodsByName[a.name].effectiveQuality)[0];
}

function naturalTrunk(bot, pos) {
    const block = bot.blockAt(pos);
    const species = block?.name?.slice(0, -4);
    if (!block || !logName(block.name) || block.getProperties().axis !== 'y') return false;
    if (!/^(grass_block|dirt|podzol|mud|moss_block|mangrove_roots|muddy_mangrove_roots)$/.test(bot.blockAt(pos.offset(0, -1, 0))?.name ?? '')) return false;
    if ([1, 2].some(y => bot.blockAt(pos.offset(0, y, 0))?.name !== block.name)) return false;
    let leaves = 0;
    for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1]]) {
        const canopy = bot.blockAt(pos.offset(x, 3, z));
        if (canopy?.name === species + '_leaves' && canopy.getProperties().persistent === false) leaves++;
    }
    if (leaves < 3) return false;
    for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) for (let y = -1; y <= 3; y++) {
        const around = bot.blockAt(pos.offset(x, y, z));
        if (!around || !natural.test(around.name) || (around.name.endsWith('_leaves') && around.getProperties().persistent !== false)) return false;
    }
    return !Object.values(bot.players).some(player =>
        player.username !== bot.username && player.entity?.position.distanceTo(pos) < 10);
}

function attachIdle(bot, { isIdle, isEnabled, setWalking, log, greetings }) {
    let worker, job, home, requested = 0, pending = 0, turn = 0, delayUntil = 0, nextHarvest = 0;
    let expected = performance.now() + interval, lagUntil = 0;
    let started = 0;
    let current = { type: 'idle' };
    let detached = false;
    let nextSwing = 0, nextGear = 0, nextShelter = 0, nextBarricade = 0, refuge, pillarAttempt;
    let tunnelSteps = 0, tunnelSeal;
    let fleeUntil = 0, resumeUntil = 0, deferredPursuit, nextCombatCraft = 0;
    let coverUntil = 0, shieldRaised = false, shieldEquipped = false, nextShieldCraft = 0;
    let woodFailures = 0, woodTrip, nextForestRoute = 0;
    let woodCheckedAt = 0, lastWoodCount = -1;
    let forestStalls = 0, forestBearing, forestTrunk, forestAscent, nextBiomeScan = 0;
    let failedForestEscapes = 0, nextEscapePillar = 0, restockPillarActive = false, nextRestockPillar = 0;
    const missedForest = new Map();
    const missedForestHeadings = new Map();
    const recentForestSteps = [];
    const missedForestSteps = new Map();
    const missedGear = new Map();
    let vineStalls = 0, vineStallCell, lastStalledTree;
    let earlySpawnStage = false, nextSpawnStep = 0, spawnWaypoints = [];
    let spawnCanopyRoute = [];
    const spawnStalls = [];
    const missedSpawnSteps = new Map();
    let nextBedAttempt = 0, nextBedHit = 0;
    const missedSheep = new Map();
    const missedSteps = new Map();
    let detour, detourY, ironHeading = 0;
    const detourVisited = new Set();
    const missedStoneEntrances = new Map();
    const missedAscent = new Map();
    let fallbackAscent = false;
    const recentFlees = [];
    const ends = { wander: 13_000, follow: 10_000, gather: 22_000, collect: 12_000 };
    const diamond = attachDiamond(bot, safeFood, { log });
    let foodAscentUntil = 0;
    let lastHealth, healthChangedAt = 0, healthReady = true;
    const food = createFoodRecovery(bot, { setWalking, change, isActive: canRun, placed: diamond.station,
        clearPickup,
        beforeTask: () => { if (job || pending) cancel(); },
        onSearchStall: point => {
            log(`Food search stalled at ${pos().floored()} toward ${point}`);
            foodAscentUntil = performance.now() + 3000;
        },
        canBurnWood: item => woodUnits(inventory()) - (logName(item.name) ? 4 : 1) >= reserveWood });
    const postStatus = createStatusTicker({
        checkpoint: diamond.announcement,
        record: diamond.announce,
        enabled: diamond.statusLoopEnabled,
        send: message => bot.chat(message),
        read: () => {
            if (bot._client?.state !== 'play' || !bot.entity?.position || bot.health <= 0) return;
            const type = !isIdle() ? 'manual action' : current.type;
            const goal = diamond.status();
            return { position: bot.entity.position, health: bot.health, food: bot.food, items: inventory(),
                task: type === 'idle' ? goal.phase : type, active: type !== 'idle', stage: goal.stage };
        },
    });
    const statusTimer = setInterval(() => {
        try { postStatus(); } catch (error) { log(`Status announcement skipped: ${error.code ?? error.name}`); }
    }, 1000);
    statusTimer.unref();
    function change(state) {
        if (state.type !== current.type) log(`Idle behavior: ${state.type}${state.target ? ' ' + JSON.stringify(state.target) : ''}`);
        current = state;
    }
    function cancel(pause = 0) {
        food.stop();
        pending = 0;
        delayUntil = Math.max(delayUntil, performance.now() + pause);
        if (job) {
            const old = job;
            job = undefined;
            if (old.kind === 'forest') {
                if (old.lastPosition) woodTrip.walked += old.lastPosition.distanceTo(pos());
                recordForestTrip();
            }
            bot.pathfinder.setGoal(null);
            if (old.digging) bot.stopDigging();
            if (old.eating) bot.deactivateItem();
            if (old.window) old.window.close();
            bot.clearControlStates();
        }
        change({ type: 'idle' });
    }
    function canRun() {
        return !detached && isEnabled() && isIdle() && bot.game?.gameMode === 'survival'
            && bot.entity?.position && bot.health > 0;
    }
    function eligible() {
        return canRun() && healthReady && bot.food > urgentHunger;
    }
    const pos = () => bot.entity.position;
    const inventory = () => bot.inventory?.items() ?? [];
    const offhand = () => bot.inventory?.slots?.[bot.getEquipmentDestSlot?.('off-hand')];
    const hasShield = () => offhand()?.name === 'shield';
    function lowerShield() {
        if (!shieldRaised) return;
        shieldRaised = false;
        bot.deactivateItem?.();
    }
    function guard(threats) {
        const enemy = threats.find(e => archer.test(e.name) && lineClear(bot, eye(bot.entity), eye(e)))
            ?? threats.find(e => e.position.distanceTo(pos()) <= 4);
        if (!enemy || !hasShield() || job?.swinging || job?.type === 'eat' || job?.type === 'place_archer_cover') {
            lowerShield();
            return;
        }
        if (!shieldRaised && typeof bot.activateItem === 'function') {
            bot.activateItem(true);
            shieldRaised = true;
        }
        if (!job?.walkingDirect && !bot.pathfinder.goal)
            void bot.lookAt?.(eye(enemy), true)?.catch(() => {});
    }
    const night = () => bot.time?.isDay === false
        || (bot.time?.timeOfDay >= 13000 && bot.time?.timeOfDay <= 23000)
        || (bot.isRaining && bot.thunderState > 0);
    const dusk = () => bot.time?.timeOfDay >= 12000 && bot.time?.timeOfDay < 13000;
    const eye = entity => entity.position.offset(0, entity.eyeHeight ?? (entity.height ?? 1.8) * 0.85, 0);
    const firstHit = (block, from) => {
        const aim = block.position.offset(0.5,0.5,0.5);
        const delta = aim.minus(from), length = delta.norm();
        return bot.world.raycast(from, delta.normalize(), length + 0.02,
            (candidate, iterator) => candidate.position.equals(block.position) || Boolean(iterator.intersect(candidate.shapes, candidate.position)));
    };
    const visibleFrom = (block, from) => firstHit(block, from)?.position.equals(block.position);
    const inSight = block => visibleFrom(block, eye(bot.entity));
    const grounded = (point, clearance = air) => {
        const floor = bot.blockAt(point.offset(0, -1, 0));
        return floor?.boundingBox === 'block' && !hazard(floor)
            && clearance(bot.blockAt(point)) && clearance(bot.blockAt(point.offset(0, 1, 0)));
    };
    const groundCell = () => {
        const feet = pos().floored();
        return pos().y - feet.y >= 0.875 && bot.blockAt(feet)?.name === 'mud' ? feet.offset(0,1,0) : feet;
    };
    const foliage = block => block?.name?.endsWith('_leaves') && block.getProperties().persistent === false;
    const nearPlayer = point => Object.values(bot.players ?? {}).some(p =>
        p.username !== bot.username && p.entity?.position.distanceTo(point) < 12);
    const actionValid = action => job === action && canRun();
    const threatList = (radius = 12) => Object.values(bot.entities ?? {}).filter(e => e.type === 'hostile' && e.isValid !== false
        && e.position && e.position.distanceTo(pos()) <= (archer.test(e.name) ? 16 : radius))
        .sort((a, b) => pos().distanceTo(a.position) - pos().distanceTo(b.position)).slice(0, 12);
    const canHit = entity => entity.position.distanceTo(pos()) <= hitReach && lineClear(bot, eye(bot.entity), eye(entity));
    const urgent = threats => {
        const now = performance.now();
        const visible = e => lineClear(bot, eye(bot.entity), eye(e));
        const active = threats.filter(e => (!meleeThreat(e) || Math.abs(e.position.y - pos().y) <= hitReach)
            && ((!archer.test(e.name) && e.position.distanceTo(pos()) <= 4) || visible(e)));
        if (now < resumeUntil) return active.filter(e => e.name !== 'creeper' || canHit(e));
        if (threatMode(active, bot.health) !== 'fight') return active;
        return active.filter(e => {
            if (archer.test(e.name)) return true;
            if (meleePursuer.test(e.name) && Math.abs(e.position.y - pos().y) > hitReach) return false;
            return deferredPursuit?.entity !== e || now >= deferredPursuit.until || e.position.distanceTo(pos()) <= 4;
        });
    };

    function begin(type, kind, target, duration) {
        cancel();
        job = { type, kind, target, until: performance.now() + duration };
        change({ type, target: target?.x === undefined ? target : coords(target) });
        return job;
    }
    function walk(point, range = 0) {
        setWalking(bot);
        bot.pathfinder.setGoal(new goals.GoalNear(point.x, point.y, point.z, range));
    }
    function directWalkSafe(target, cleared) {
        const start = pos();
        const origin = groundCell();
        const blockAt = point => cleared?.equals(point) ? { name: 'air' } : bot.blockAt(point);
        const stand = point => {
            const floor = blockAt(point.offset(0,-1,0));
            return floor?.boundingBox === 'block' && !hazard(floor)
                && [point, point.offset(0,1,0)].every(cell => woodTrail(blockAt(cell)));
        };
        const dx = target.x - start.x, dz = target.z - start.z;
        const distance = Math.hypot(dx, dz);
        if (distance > 4 || distance <= 0.23 || target.y > origin.y || target.y < origin.y - 1) return false;
        const samples = Math.ceil(distance / 0.2);
        let level = origin.y;
        for (let i = 1; i <= samples; i++) {
            const x = start.x + dx * i / samples, z = start.z + dz * i / samples;
            let point = new Vec3(Math.floor(x), level, Math.floor(z));
            if (!stand(point)) {
                if (level !== origin.y || !woodTrail(blockAt(point.offset(0,1,0)))) return false;
                point = point.offset(0,-1,0);
                if (!stand(point)) return false;
                level--;
            }
            if (nearPlayer(point)) return false;
            for (const [ox,oz] of offsets.slice(0,4)) {
                const side = new Vec3(Math.floor(x + ox*0.29), level, Math.floor(z + oz*0.29));
                if (![side, side.offset(0,1,0)].every(cell => woodTrail(blockAt(cell)))) return false;
            }
        }
        return level === target.y;
    }
    function directWalk(action, target, onFinish = () => {}, active = () => actionValid(action)) {
        if (typeof bot.lookAt !== 'function' || typeof bot.setControlState !== 'function' || !directWalkSafe(target)) return false;
        action.walkingDirect = true;
        bot.pathfinder.setGoal(null);
        void (async () => {
            await bot.lookAt(target.offset(0, eye(bot.entity).y - target.y, 0), true);
            if (!active() || !directWalkSafe(target)) return;
            bot.setControlState('forward', true);
            for (let i = 0; i < 36 && active() && directWalkSafe(target); i++) await wait(50);
        })().catch(error => {
            if (active()) log(`Direct step skipped: ${error.name}`);
        }).finally(() => {
            if (!active()) return;
            bot.setControlState('forward', false);
            action.walkingDirect = false;
            onFinish();
        });
        return true;
    }
    function clearPickup(action, drop, active = () => actionValid(action)) {
        if (action.stationName) return false;
        if (typeof bot.lookAt !== 'function' || typeof bot.setControlState !== 'function'
            || !bot.entity.onGround || drop.position.distanceTo(pos()) > 4 || nearPlayer(drop.position)) return false;
        const raw = drop.position.floored();
        const cell = drop.position.y - raw.y >= 0.875 && bot.blockAt(raw)?.name === 'mud' ? raw.offset(0,1,0) : raw;
        const liveDrop = () => active() && bot.entities?.[drop.id] && !nearPlayer(drop.position);
        const aim = point => point.offset(0.5,0,0.5);
        if (directWalk(action, aim(cell), undefined, active)) return true;
        const origin = groundCell();
        const points = [cell, ...offsets.slice(0,4).map(([x,z]) => cell.offset(x,0,z))];
        const route = points.flatMap(point => [point, point.offset(0,1,0), point.offset(0,-1,0)])
            .map(point => bot.blockAt(point)).flatMap(block => {
                if (!block?.position || !(foliage(block) || stationSoil.test(block.name) || diggableGround.test(block.name))
                    || block.position.x === origin.x && block.position.z === origin.z && block.position.y < origin.y
                    || nearPlayer(block.position) || !bot.canDigBlock?.(block) || !inSight(block)
                    || !dryNeighborhood(bot, block.position) || !overheadStable(block.position)) return [];
                return [cell, cell.offset(0,-1,0)]
                    .filter(point => directWalkSafe(aim(point), block.position))
                    .filter(point => point.equals(cell) || block.position.equals(point))
                    .map(point => ({ block, point }));
            })[0];
        if (!route) return false;
        action.digging = true;
        bot.pathfinder.setGoal(null);
        log(`Pickup stalled: clearing ${route.block.name} at ${route.block.position} for drop at ${cell}`);
        void (async () => {
            try {
                if (liveDrop()) await bot.dig(route.block, true);
                if (liveDrop()) directWalk(action, aim(route.point), undefined, active);
            } catch (error) {
                if (active()) log(`Pickup clearance skipped: ${error.name}`);
            } finally {
                action.digging = false;
                if (active()) action.landing = undefined;
            }
        })();
        return true;
    }
    function recoverPickup(action, drop, now) {
        if (!drop) return false;
        if (action.drop !== drop) {
            action.drop = drop;
            action.pickupSince = now;
            action.pickupRecovery = false;
        }
        action.pickupSince ??= now;
        if (action.hopping || action.pickupRecovery || now - action.pickupSince < 5000 || !clearPickup(action, drop))
            return false;
        action.pickupRecovery = true;
        action.until = now + 5000;
        return true;
    }
    function walkToGearDrop(action, drop, now) {
        if (!drop || nearPlayer(drop.position) || now >= action.until || (action.directAttempts ?? 0) >= 2) return false;
        const target = drop.position.clone();
        const cell = target.floored();
        const origin = groundCell();
        target.y = Math.min(origin.y, target.y - cell.y >= 0.875 && bot.blockAt(cell)?.name === 'mud'
            ? cell.y + 1 : cell.y);
        const nearby = offsets.slice(0,4).flatMap(([x,z]) => [0,-1].map(y => origin.offset(x+0.5,y,z+0.5)))
            .filter(point => point.distanceTo(target) < pos().distanceTo(target))
            .sort((a,b) => a.distanceTo(target) - b.distanceTo(target));
        const step = [target, ...nearby].find(point => directWalkSafe(point)
            && (!action.stationName || stationPickupGround(groundCell()) && stationPickupGround(point.floored())));
        if (!step || !directWalk(action, step, () => { action.landing = undefined; })) return false;
        action.directAttempts = (action.directAttempts ?? 0) + 1;
        action.until = now + 5000;
        log(`Pickup stalled: walking directly toward ${action.stationName ?? 'log'} at ${target} via ${step}`);
        return true;
    }
    function stalled(action, now) {
        const goal = bot.pathfinder.goal;
        if (!goal || action.digging || action.swinging
            || action.type === 'follow' && goal.isEnd(groundCell())) {
            action.motion = undefined;
            return false;
        }
        const previous = action.motion;
        if (!previous || previous.goal !== goal || previous.position.distanceTo(pos()) >= 0.35) {
            action.motion = { goal, position: pos().clone(), since: now };
            return false;
        }
        if (now - previous.since < walkStall) return false;
        log(`Movement stalled: ${action.type} at ${pos().floored()} target=${action.target}; replanning`);
        const spawn = diamond.spawnRelocation();
        if (earlySpawnStage && spawn && !spawn.base && !spawn.escape && horizontal(spawn.origin, pos()) <= spawnRadius
            && ['reserve', 'forest', 'gear', 'diamond', undefined].includes(action.kind) && !action.spawnStall) {
            action.spawnStall = true;
            spawnStalls.push(now);
        }
        return true;
    }
    function perform(action, fn, pause = 0) {
        void fn().catch(error => {
            if (job === action) log(`Idle ${action.type} skipped: ${error.code ?? error.name}`);
        }).finally(() => { if (job === action) cancel(pause); });
    }
    function fleeSpot(threats) {
        const origin = pos().floored();
        const distance = point => Math.min(...threats.map(e => e.position.distanceTo(point)));
        const from = distance(origin);
        let best, score = -Infinity;
        for (const [x,z] of offsets) for (const steps of [4, 7]) for (const y of [0, 1, -1]) {
            const point = origin.offset(x * steps, y, z * steps);
            if (!grounded(point) || distance(point) < from + 1.5) continue;
            const cover = threats.some(e => ranged.test(e.name) && !lineClear(bot, eye(e), point.offset(0.5, 1.5, 0.5)));
            const light = bot.blockAt(point).light ?? 0;
            const recent = recentFlees.some(old => point.distanceTo(old) < 2);
            const candidate = distance(point) + light * 0.35 + (cover ? 5 : 0) - (recent ? 8 : 0);
            if (candidate > score) { score = candidate; best = point; }
        }
        return best;
    }
    function archerCover(threats, now) {
        if (job?.type === 'take_cover' && now < job.until && !stalled(job, now)) return true;
        if (barricade(threats[0], now)) return true;
        const origin = groundCell();
        const behindCover = point => threats.every(e => !lineClear(bot, eye(e), point.offset(0.5,1.5,0.5)));
        const candidates = offsets.flatMap(([x,z]) => [1,2,4,7].flatMap(n => [0,1,-1]
            .map(y => origin.offset(x*n,y,z*n)))).filter(point => grounded(point)
            && !nearPlayer(point) && behindCover(point));
        candidates.sort((a,b) => origin.distanceTo(a) - origin.distanceTo(b));
        const spot = candidates.find(point => !recentFlees.some(old => old.equals(point)));
        if (spot) {
            recentFlees.push(spot);
            if (recentFlees.length > 4) recentFlees.shift();
            const action = begin('take_cover', 'threat', spot, 3000);
            if (directWalk(action, spot.offset(0.5,0,0.5))) return true;
            walk(spot);
            return true;
        }
        const enemy = threats[0];
        const escape = offsets.map(([x,z]) => origin.offset(x,0,z)).filter(point => grounded(point))
            .sort((a,b) => b.distanceTo(enemy.position) - a.distanceTo(enemy.position))
            .find(point => directWalkSafe(point.offset(0.5,0,0.5)));
        if (escape) {
            const action = begin('take_cover', 'threat', escape, 1200);
            return directWalk(action, escape.offset(0.5,0,0.5));
        }
        const distant = fleeSpot(threats);
        if (!distant) return false;
        begin('take_cover', 'threat', distant, 2500);
        walk(distant);
        return true;
    }
    function retreat(threats, now) {
        if (job?.type === 'flee' && now < job.until && !stalled(job, now)) return true;
        const spot = fleeSpot(threats);
        if (!spot) return false;
        begin('flee', 'threat', spot, 3500);
        walk(spot);
        return true;
    }
    function scaffold(minimum) {
        return inventory().filter(item => item.count >= minimum && (buildingBlock.test(item.name)
            || scaffoldMaterial.test(item.name)
            || bot.registry?.blocksByName?.[item.name]?.boundingBox === 'block'
                && !fallingBlock.test(item.name) && !hazard(item)))
            .sort((a,b) => Number(defenseReserve.test(b.name)) - Number(defenseReserve.test(a.name)))[0];
    }
    function pillar(threats) {
        const material = scaffold(3);
        const point = groundCell();
        if (!material || nearPlayer(point) || !grounded(point) || pillarAttempt?.equals(point)
            || threats.some(e => ranged.test(e.name) || volatile.test(e.name))
            || [0,1,2,3,4].some(y => !air(bot.blockAt(point.offset(0,y,0))))) return false;
        setWalking(bot);
        const movement = bot.pathfinder.movements;
        const id = material.type ?? bot.registry?.itemsByName?.[material.name]?.id;
        if (!movement || id === undefined) return false;
        pillarAttempt = point;
        movement.allow1by1towers = true;
        movement.canDig = false;
        movement.scafoldingBlocks = [id];
        const inColumn = block => block.position?.x === point.x && block.position?.z === point.z ? 0 : 100;
        movement.exclusionAreasPlace?.push(inColumn);
        movement.exclusionAreasStep?.push(inColumn);
        const top = point.offset(0,3,0);
        const action = begin('pillar_safety', 'threat', top, 4200);
        action.base = point;
        action.blockName = material.name;
        bot.pathfinder.setGoal(new goals.GoalBlock(top.x, top.y, top.z));
        return true;
    }
    function handleThreat(threats, now) {
        const active = urgent(threats);
        if (!active.length) { fleeUntil = 0; return false; }
        const archers = active.filter(e => archer.test(e.name));
        const melee = active.filter(meleeThreat);
        const target = melee.find(canHit) ?? melee[0] ?? archers[0] ?? active[0];
        const items = inventory();
        const sword = bestWeapon(items.filter(item => item.name.endsWith('_sword')));
        const weapon = sword ?? bestWeapon(items) ?? items.filter(item => /_pickaxe$/.test(item.name))
            .sort((a,b) => pickTier(b.name) - pickTier(a.name))[0];
        let mode = threatMode(active, bot.health);
        const rush = archer.test(target.name) && hasShield() && weapon && bot.health > 12
            && target.position.distanceTo(pos()) <= 4 && now >= coverUntil;
        if (mode !== 'flee' && archers.length && !rush) {
            if (!archerCover(archers, now) && !digRefuge(false, now) && job?.kind !== 'threat') cancel();
            return true;
        }
        if (mode === 'shelter') {
            if (pillar(active) || digRefuge(false, now)) return true;
            mode = 'fight';
        }
        if (mode !== 'flee' && (bot.health <= 10 && weapon || !meleeTiming)) {
            if (retreat(active, now) || digRefuge(false, now)) return true;
            if (job?.type === 'fight') cancel();
            return true;
        }
        if (mode !== 'flee') {
            fleeUntil = 0;
            if (job?.combatPack && active.every(e => e.position.distanceTo(pos()) > 4)) {
                if (now >= job.until) cancel();
                else if (job.kind === 'gear') return gear(now, threats);
                else return true;
            }
            if (job?.type === 'arm_for_combat') {
                if (now < job.until && active.every(e => e.position.distanceTo(pos()) > 4)) return true;
                cancel();
            }
            const distance = target.position.distanceTo(pos());
            if (!archers.length && bot.health > 8 && !sword && now >= nextCombatCraft && active.length === 1 && distance > 4
                && countPlanks(items) >= 2 && woodUnits(items) >= reserveWood + 2 && items.some(item => item.name === 'stick')) {
                nextCombatCraft = now + fleeLimit;
                const table = localStation(diamond.stations().stationPoint, 'crafting_table');
                if (table || items.some(item => item.name === 'crafting_table')) {
                    const action = begin('arm_for_combat', 'threat', 'wooden_sword', 4000);
                    log('Combat decision: craft wooden_sword before the hostile reaches melee range');
                    perform(action, async () => {
                        const bench = table ?? await workstation('crafting_table', action,
                            threats => threats.some(e => e.position.distanceTo(pos()) <= 4));
                        if (!bench || !actionValid(action)) return;
                        const recipe = bot.recipesFor(bot.registry.itemsByName.wooden_sword.id, null, 1, bench)[0];
                        if (recipe) await bot.craft(recipe, 1, bench);
                        if (actionValid(action) && packWorkstation(bench)) job.combatPack = true;
                    });
                    return true;
                }
                log('Combat decision: cannot craft wooden_sword without a local or carried crafting table');
            }
            if (!weapon) {
                if (pillar(active) || digRefuge(false, now) || retreat(active, now)) return true;
                if (!canHit(target)) {
                    if (job?.type === 'fight') cancel();
                    return true;
                }
            }
            if (job?.type !== 'fight' || job.entity !== target) {
                const action = begin('fight', 'threat', target.name, 6500);
                action.entity = target;
                action.origin = pos().clone();
                log(`Combat decision: fight ${target.name} range=${distance.toFixed(1)} health=${bot.health} weapon=${weapon?.name ?? 'hand'}`);
                setWalking(bot);
                if (rush && bot.pathfinder.movements) bot.pathfinder.movements.allowSprinting = true;
                if (weapon) bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true);
            }
            const action = job;
            const hittable = canHit(target);
            if (!hittable && !action.swinging && !action.waitUntil
                && (action.pathFailed || stalled(action, now) || now >= action.until)) {
                if (rush) {
                    coverUntil = now + 2500;
                    if (archerCover(archers, now)) return true;
                    action.until = now + 1000;
                    action.pathFailed = false;
                    bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true);
                    return true;
                }
                action.waitUntil = now + 2000;
                bot.pathfinder.setGoal(null);
                log(`Combat pursuit: ${target.name} path=${action.pathStatus ?? 'unreported'} range=${distance.toFixed(1)} moved=${pos().distanceTo(action.origin).toFixed(1)} LOS=${lineClear(bot, eye(bot.entity), eye(target))} reset=${action.pathReset ?? 'none'}; waiting for melee range`);
            }
            if (!hittable && action.waitUntil && now >= action.waitUntil) {
                deferredPursuit = { entity: target, until: now + pursuitRetry };
                log(`Combat pursuit: ${target.name} stayed out of reach; resuming task temporarily`);
                cancel();
                return active.length > 1;
            }
            if (!action.swinging && now >= nextSwing && hittable) {
                action.swinging = true;
                action.waitUntil = 0;
                action.pathFailed = false;
                void (async () => {
                    if (shieldRaised) {
                        lowerShield();
                        await wait(100);
                        if (!actionValid(action)) return;
                    }
                    if (weapon && bot.heldItem?.name !== weapon.name) await bot.equip(weapon, 'hand');
                    if (!actionValid(action) || target.isValid === false || !canHit(target)) return;
                    bot.pathfinder.setGoal(null);
                    await bot.lookAt(eye(target), true);
                    if (!actionValid(action) || target.isValid === false || !canHit(target)) return;
                    const feet = groundCell();
                    if (!rush && bot.entity.onGround && bot.entity.velocity && !bot.entity.isInWater
                        && target.position.distanceTo(pos()) <= 2.3 && air(bot.blockAt(feet.offset(0,2,0)))) {
                        bot.setControlState('jump', true);
                        await wait(60);
                        if (!actionValid(action)) return;
                        bot.setControlState('jump', false);
                        for (let i = 0; i < 8 && !bot.entity.onGround && bot.entity.velocity.y >= 0 && canHit(target); i++) {
                            await wait(50);
                            if (!actionValid(action)) return;
                        }
                        if (target.isValid === false || !canHit(target)) return;
                    }
                    const canTimeAttack = meleeTiming && bot.inventory?.slots && typeof bot.getEquipmentDestSlot === 'function';
                    nextSwing = performance.now() + (canTimeAttack ? meleeTiming.getTicks(bot) * 50
                        : weapon?.name.endsWith('_axe') ? 1250 : weapon?.name.endsWith('_pickaxe') ? 850 : 650);
                    bot.attack(target);
                    const away = pos().minus(target.position);
                    away.y = 0;
                    if (!away.norm()) return;
                    const step = pos().plus(away.normalize().scaled(0.9));
                    step.y = groundCell().y;
                    if (!rush && directWalkSafe(step)) {
                        bot.setControlState('back', true);
                        await wait(240);
                        if (actionValid(action)) bot.setControlState('back', false);
                    }
                })().catch(error => { if (actionValid(action)) log(`Combat hit failed: ${error.code ?? error.name}`); }).finally(() => {
                    if (actionValid(action)) {
                        action.swinging = false;
                        action.until = performance.now() + 6500;
                        if (target.isValid !== false) bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true);
                    }
                });
            }
        } else {
            if (!fleeUntil) {
                fleeUntil = now + fleeLimit;
                log(`Combat decision: flee ${active.map(e => e.name).join(',')} health=${bot.health}`);
            }
            if (now >= fleeUntil && !archers.length) {
                resumeUntil = now + threatPause;
                fleeUntil = 0;
                log('Combat decision: flee limit reached; resuming task temporarily');
                cancel();
                return false;
            }
            if (job?.kind === 'threat' && job.type !== 'fight' && job.type !== 'arm_for_combat' && now < job.until) return true;
            const spot = fleeSpot(active);
            if (spot) {
                recentFlees.push(spot);
                if (recentFlees.length > 4) recentFlees.shift();
                begin('flee', 'threat', spot, 3800);
                walk(spot);
            } else begin('flee', 'threat', target.name, 1400);
        }
        return true;
    }
    function sealAnchor(point) {
        for (const face of stationFaces) {
            const reference = bot.blockAt(point.minus(face));
            if (stationSupport(reference) && !fallingBlock.test(reference.name)) return { reference, face };
        }
    }
    function capOccupant(point) {
        return [bot.entity, ...Object.values(bot.entities ?? {})].find(entity => {
            const p = entity.position;
            if (!p || entity.isValid === false || entity !== bot.entity
                && /^(?:item|experience_orb|arrow|spectral_arrow)$/.test(entity.name)) return false;
            const radius = (entity.width || 0.6) / 2;
            return p.x + radius > point.x && p.x - radius < point.x + 1
                && p.z + radius > point.z && p.z - radius < point.z + 1
                && p.y + (entity.height || 1.8) > point.y && p.y < point.y + 1;
        });
    }
    function capPlacement(point) {
        if (!air(bot.blockAt(point))) return { reason: 'target is not air' };
        const occupant = capOccupant(point);
        if (occupant) return { reason: `entity in target cell: ${occupant === bot.entity ? 'self' : occupant.name ?? occupant.id}` };
        const from = eye(bot.entity);
        const anchors = stationFaces.flatMap(face => {
            const reference = bot.blockAt(point.minus(face));
            return stationSupport(reference) && !fallingBlock.test(reference.name)
                ? [{ reference, face, hit: point.offset(0.5,0.5,0.5).minus(face.scaled(0.49)) }] : [];
        });
        if (!anchors.length) return { reason: 'no solid reference face' };
        const reachable = anchors.filter(({ hit }) => from.distanceTo(hit) <= 4.5);
        if (!reachable.length) return { reason: 'reference face is out of reach' };
        return reachable.find(({ face, hit }) => from.minus(hit).dot(face) > 0 && lineClear(bot, from, hit))
            ?? { reason: 'reference face is obstructed or faces away' };
    }
    function pillarAfterSeal(shelter) {
        const base = groundCell();
        if (!bot.entity.onGround || !pos().floored().equals(base) || !grounded(base)
            || typeof bot.look !== 'function' || typeof bot.lookAt !== 'function' || typeof bot.setControlState !== 'function') return false;
        const clearance = point => !nearPlayer(point) && overheadStable(point) && dryNeighborhood(bot, point)
            && [bot.entity, undefined].includes(capOccupant(point));
        const depth = Math.max(0, shelter.entry.y - base.y);
        const height = [depth + 3, depth + 2].find(h => scaffold(h)
            && Array.from({ length: h + 2 }, (_, y) => base.offset(0,y,0))
                .every(point => air(bot.blockAt(point)) && clearance(point)));
        if (!height) return false;
        const material = scaffold(height);
        const top = base.offset(0,height,0);
        const action = begin('pillar_after_seal_failure', 'shelter', top, 12_000);
        perform(action, async () => {
            const result = await climbPillar(bot, { base, height, material, active: () => actionValid(action), safe: clearance });
            if (!actionValid(action)) return;
            if (result.reason) log(`Shelter fallback pillar stopped after ${result.placed} blocks: ${result.reason}`);
            else {
                refuge = { ...shelter, type: 'pillar', feet: top, entry: base, blockName: material.name };
                log(`Shelter fallback pillar: landed on ${top}`);
            }
        });
        return true;
    }
    async function sealShelter(action, shelter, material) {
        let point = shelter.cap;
        let placement = capPlacement(point);
        if (placement.reason) {
            const higher = point.offset(0,1,0);
            const alternative = capPlacement(higher);
            if (!alternative.reason) { point = higher; placement = alternative; }
        }
        let reason = material ? placement.reason : 'no block in hand or available to equip';
        if (!reason) {
            const { reference, face } = placement;
            try {
                await bot.equip(material, 'hand');
                if (!actionValid(action)) return;
                const current = capPlacement(point);
                if ('heldItem' in bot && bot.heldItem?.name !== material.name) reason = 'no matching block in hand after equip';
                else if (current.reason) reason = current.reason;
                else {
                    await bot.placeBlock(current.reference, current.face);
                    if (bot.blockAt(point)?.name !== material.name) reason = 'no placement confirmation';
                }
            } catch (error) {
                reason = `${error.message ?? error.name}; reference=${reference.position} face=${face} reach=${eye(bot.entity).distanceTo(placement.hit).toFixed(2)}`;
            }
        }
        if (!actionValid(action)) return;
        if (!reason || material && bot.blockAt(point)?.name === material.name) {
            shelter.cap = point;
            return;
        }
        log(`Shelter seal failed at ${point}: ${reason}`);
        shelter.sealFailed = true;
        nextShelter = performance.now() + 10_000;
        if (!pillarAfterSeal(shelter)) log('Shelter fallback pillar unavailable: no safe column or scaffold');
    }
    function barricade(enemy, now) {
        if (!enemy || now < nextBarricade || typeof bot.placeBlock !== 'function' || typeof bot.equip !== 'function') return false;
        const from = eye(bot.entity), to = eye(enemy), origin = groundCell();
        if (!lineClear(bot, from, to)) return false;
        const ray = to.minus(from), direction = ray.normalize();
        const items = inventory();
        const material = items.find(item => item.name === 'dirt') ?? scaffold(1);
        if (!material) return false;
        const candidates = new Map();
        for (let d = 0.25; d < Math.min(2.75, ray.norm()); d += 0.125) {
            const cell = from.plus(direction.scaled(d)).floored();
            if (cell.x === origin.x && cell.z === origin.z || cell.equals(enemy.position.floored())
                || nearPlayer(cell) || !air(bot.blockAt(cell))) continue;
            candidates.set(cell.toString(), cell);
        }
        const cells = [...candidates.values()];
        const direct = cells.find(cell => sealAnchor(cell));
        const raised = !direct && material.count >= 2 && cells.find(cell => {
            const base = cell.offset(0,-1,0);
            return air(bot.blockAt(base)) && !nearPlayer(base) && sealAnchor(base);
        });
        const cover = direct || raised;
        if (!cover) return false;
        lowerShield();
        nextBarricade = now + 2500;
        const action = begin('place_archer_cover', 'threat', cover, 3000);
        perform(action, async () => {
            await bot.equip(material, 'hand');
            if (!actionValid(action) || !lineClear(bot, eye(bot.entity), eye(enemy))) return;
            for (const point of raised ? [cover.offset(0,-1,0), cover] : [cover]) {
                const anchor = sealAnchor(point);
                if (!actionValid(action) || !anchor || !air(bot.blockAt(point)) || nearPlayer(point)
                    || groundCell().x === point.x && groundCell().z === point.z) return;
                await bot.placeBlock(anchor.reference, anchor.face);
            }
        });
        return true;
    }
    function digRefuge(weather, now, early = false) {
        if (now < nextShelter || typeof bot.placeBlock !== 'function' || typeof bot.canDigBlock !== 'function') return false;
        const entry = groundCell();
        const material = inventory().find(item => item.name === 'dirt') ?? scaffold(1);
        if (!material || nearPlayer(entry) || !grounded(entry, woodTrail) || !overheadStable(entry)) return false;
        const anchoredAtSurface = offsets.slice(0,4).some(([x,z]) => stationSupport(bot.blockAt(entry.offset(x,0,z))));
        const shallowCap = entry.offset(0,1,0);
        const shallow = early && air(bot.blockAt(shallowCap)) && !nearPlayer(shallowCap) && sealAnchor(shallowCap);
        const depth = shallow ? 1 : anchoredAtSurface ? 2 : 3;
        const cap = entry.offset(0,2-depth,0);
        const feet = entry.offset(0,-depth,0);
        const cells = Array.from({ length: depth }, (_,i) => entry.offset(0,-i-1,0));
        const shell = [feet.offset(0,-1,0), ...(shallow ? [feet] : [feet, feet.offset(0,1,0)]).flatMap(point =>
            offsets.slice(0,4).map(([x,z]) => point.offset(x,0,z)))];
        if (!shell.every(point => stationSupport(bot.blockAt(point)))
            || !cells.every(point => {
                const block = bot.blockAt(point);
                return diggableGround.test(block?.name) && dryNeighborhood(bot, point);
            })) return false;
        nextShelter = now + 2500;
        const digBudget = cells.reduce((total, point) => total + (bot.digTime?.(bot.blockAt(point)) ?? 0), 5000);
        const action = begin(weather ? 'dig_night_shelter' : 'dig_emergency_shelter', 'shelter', feet, Math.max(10_000, digBudget));
        action.digging = true;
        perform(action, async () => {
            for (const point of cells) {
                if (!actionValid(action) || nearPlayer(point) || !dryNeighborhood(bot, point)) return;
                const block = bot.blockAt(point);
                if (!diggableGround.test(block?.name) || !bot.canDigBlock(block)) return;
                await bot.dig(block, true);
                for (let i = 0; i < 20 && actionValid(action) && pos().y > point.y + 0.01; i++) {
                    if (i === 6 && pos().floored().equals(point) && typeof bot.lookAt === 'function'
                        && typeof bot.setControlState === 'function' && Math.hypot(pos().x - point.x - 0.5, pos().z - point.z - 0.5) > 0.2) {
                        await bot.lookAt(point.offset(0.5,eye(bot.entity).y - point.y,0.5), true);
                        if (!actionValid(action)) return;
                        bot.setControlState('forward', true);
                    }
                    if (i >= 6 && typeof bot.setControlState === 'function'
                        && Math.hypot(pos().x - point.x - 0.5, pos().z - point.z - 0.5) <= 0.16) bot.setControlState('forward', false);
                    await wait(50);
                }
                if (actionValid(action)) bot.setControlState?.('forward', false);
                if (!actionValid(action) || !groundCell().equals(point)) return;
            }
            action.digging = false;
            refuge = { type: 'hole', weather, early, entry, feet, cap, blockName: material.name };
            await sealShelter(action, refuge, material);
        });
        return true;
    }
    function keepRefuge(threats, now) {
        if (job?.type === 'pillar_after_seal_failure') {
            if (now < job.until) return true;
            cancel();
        }
        if (job?.type === 'pillar_safety') {
            if (groundCell().equals(job.target) && bot.entity.onGround !== false
                && bot.blockAt(job.target.offset(0,-1,0))?.name === job.blockName) {
                refuge = { type: 'pillar', feet: job.target, entry: job.base, blockName: job.blockName };
                cancel();
            } else if (now < job.until) return true;
            else cancel();
        }
        if (/^dig_(?:night|emergency)_shelter$/.test(job?.type)) {
            if (now < job.until && !urgent(threats).some(e => e.name === 'creeper' && canHit(e))) return true;
            cancel();
        }
        if (!refuge) return false;
        if (job?.type === 'leave_shelter' && now < job.until) return true;
        const { type, feet, entry, cap, weather, early, blockName } = refuge;
        const current = groundCell();
        const stay = weather ? night() || (early ? dusk() || threats.length : urgent(threats).length)
            : bot.health < 16 || threats.length;
        const climbingOut = type === 'hole' && refuge.opened && !stay && current.y >= feet.y && current.y < entry.y;
        if (!climbingOut && (current.x !== entry.x || current.z !== entry.z || current.y > Math.max(feet.y, entry.y)
            || current.y < Math.min(feet.y, entry.y) || current.equals(entry))) {
            refuge = undefined;
            return false;
        }
        const exposed = type === 'hole' && !refuge.opened && !stationSupport(bot.blockAt(cap));
        if (exposed && urgent(threats).some(canHit)) return false;
        if (!(type === 'hole' && refuge.sealFailed) && stay) {
            if (job?.type === 'eat') return true;
            const food = recoveryFood(bot);
            if (food && bot.food < 20) recover(food, now);
            else if (job?.type !== 'shelter') begin('shelter', 'shelter', feet, 8000);
            return true;
        }
        if (type === 'pillar') {
            const block = bot.blockAt(current.offset(0,-1,0));
            if (block?.name !== blockName || !bot.canDigBlock(block)) { refuge = undefined; return false; }
            const action = begin('leave_shelter', 'shelter', block.position, 4500);
            action.digging = true;
            perform(action, async () => {
                await bot.dig(block, true);
                for (let i = 0; i < 20 && actionValid(action) && groundCell().equals(current); i++) await wait(50);
            });
            return true;
        }
        const door = bot.blockAt(cap);
        if (stationSupport(door) && !refuge.opened) {
            if (!bot.canDigBlock(door)) return true;
            const action = begin('leave_shelter', 'shelter', cap, 4500);
            action.digging = true;
            perform(action, async () => {
                await bot.dig(door, true);
                if (actionValid(action)) refuge.opened = true;
            });
            return true;
        }
        refuge.opened = true;
        if (job?.kind === 'diamond') {
            if (now < job.until && !stalled(job, now)) return true;
            if (workstationStep.test(job.type)) missedAscent.set(job.target.toString(), now + 45_000);
            cancel();
        }
        if (climbStep(now, entry.offset(0,1,0), true)) return true;
        diamond.blocked('No safe escape step from the shelter');
        return true;
    }
    function naturalResource(point, mining) {
        const block = bot.blockAt(point);
        const feet = pos().floored();
        if (nearPlayer(point) || (point.x === feet.x && point.z === feet.z && point.y < feet.y)) return false;
        if (mining ? !/^(stone|deepslate)$/.test(block?.name) : !logName(block?.name)) return false;
        if (!mining && naturalTrunk(bot, point)) return true;
        let leaves = 0;
        const trunk = !mining && block.getProperties().axis === 'y' && /^(?:dirt|mud|grass_block|(?:muddy_)?mangrove_roots|.*_log)$/.test(bot.blockAt(point.offset(0,-1,0))?.name ?? '');
        for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) for (let y = -1; y <= (trunk ? 6 : 2); y++) {
            const other = bot.blockAt(point.offset(x,y,z));
            if (!other || (!natural.test(other.name) && Math.abs(x) <= 1 && Math.abs(z) <= 1
                && !(mining && /^(?:.*_ore|andesite|diorite|granite|tuff|calcite|obsidian)$/.test(other.name)))) return false;
            if (other.name.endsWith('_leaves')) {
                if (other.getProperties().persistent !== false) return false;
                if (!mining && (trunk || other.name === block.name.replace(/_log$/, '_leaves'))) leaves++;
            }
        }
        if (!mining) return leaves >= 3 && point.y <= feet.y + 5;
        return pos().floored().y <= point.y && canMine(bot, block, () => true) && offsets.slice(0,4).some(([x,z]) =>
            air(bot.blockAt(point.offset(x,0,z))) && air(bot.blockAt(point.offset(x,1,z))));
    }
    function logCover(block, feet, mangrove) {
        return block && block.position.y >= feet.y && !nearPlayer(block.position)
            && (foliage(block) || mangrove && block.name === 'mangrove_roots'
                && block.position.y > feet.y && dryNeighborhood(bot, block.position));
    }
    function gear(now, threats, forceWood = false, searching = false) {
        if (job?.kind === 'gear') {
            if (job.walkingDirect || job.pickupRecovery && job.digging) return true;
            const collecting = job.type === 'collect_gear' && job.material && !job.digging;
            const drop = collecting && (job.drop && bot.entities?.[job.drop.id] || bot.nearestEntity?.(e =>
                e.position.distanceTo(job.target) < 8 && job.material.test(e.getDroppedItem?.()?.name ?? '') && !nearPlayer(e.position)));
            if (collecting) {
                const total = inventory().filter(i => job.material.test(i.name)).reduce((n,i) => n + i.count, 0);
                if (total > job.collectedAtStart) {
                    if (job.material.test('oak_log')) woodFailures = 0;
                    if (job.stationName) diamond.station(job.stationName);
                    cancel();
                    return true;
                }
                if (recoverPickup(job, drop, now)) return true;
            }
            const stalledGear = stalled(job, now);
            if (stalledGear && job.type === 'collect_gear' && job.material?.test('oak_log')
                && bot.entities?.[job.drop?.id] && walkToGearDrop(job, job.drop, now)) return true;
            if (now < job.until && stalledGear && job.type === 'collect_gear' && !job.stationName && job.drop
                && bot.entities[job.drop.id] && job.drop.position.distanceTo(pos()) < 4
                && (job.hops ?? 0) < 3 && forestStep(job.drop.position, now, job)) return true;
            if (stalledGear && job.type === 'collect_gear' && job.stationName
                && bot.entities?.[job.drop?.id] && walkToGearDrop(job, job.drop, now)) return true;
            const waitForClearance = drop && !job.pickupRecovery && now - job.pickupSince < 5000
                && typeof bot.canDigBlock === 'function' && drop.position.distanceTo(pos()) <= 4;
            if (!waitForClearance && (now >= job.until || stalledGear)) {
                const tree = stalledGear && job.type === 'gather_gear' && job.target;
                if (job.target?.x !== undefined) missedGear.set(job.target.toString(), now + 45_000);
                if (job.resource) {
                    const block = bot.blockAt(job.target);
                    log(`Gear target timed out: ${block?.name ?? 'unloaded'} reachable=${Boolean(block && bot.canDigBlock(block))} visible=${Boolean(block && inSight(block))}`);
                    diamond.blocked(`Could not reach or expose ${block?.name ?? 'resource'} at ${job.target}`);
                } else if (job.drop && job.material?.test('oak_log')) {
                    diamond.blocked(`Could not pick up log at ${job.drop.position.floored()}`);
                }
                if (job.type === 'gather_gear' || job.material?.test('oak_log')) woodFailures++;
                if (tree && woodFailures >= 2) lastStalledTree = { point: tree, until: now + 45_000 };
                cancel();
                nextGear = now + 3000;
                if (tree && woodTrip && typeof bot.lookAt === 'function' && typeof bot.setControlState === 'function'
                    && forestStep(tree, now)) return true;
                return false;
            }
            if (collecting) {
                const action = job;
                const feet = drop?.position.floored();
                if (!feet || action.hopping) return true;
                const spots = [feet, feet.offset(0,-1,0), ...offsets.slice(0,4).map(([x,z]) => feet.offset(x,0,z))];
                const wood = action.material.test('oak_log');
                const canPickUp = point => grounded(point, wood ? woodTrail : air)
                    && (!action.stationName || stationPickupGround(point))
                    && drop.position.y >= point.y - 0.5 && drop.position.y < point.y + 1
                    && Math.abs(point.x + 0.5 - drop.position.x) < 1.1 && Math.abs(point.z + 0.5 - drop.position.z) < 1.1;
                if (!action.landing || !feet.equals(action.landing)) {
                    action.landing = feet;
                    action.walkAt = now;
                    const goal = new goals.GoalNear(feet.x, feet.y, feet.z, 2);
                    goal.isEnd = node => canPickUp(new Vec3(node.x,node.y,node.z));
                    if (wood && feet.y > groundCell().y + 1) {
                        walkStaircase(bot, setWalking, goal, block => foliage(block) && !nearPlayer(block.position));
                        bot.pathfinder.movements.exclusionAreasPlace?.push(block =>
                            air(block) && block.position.distanceTo(feet) < 8 && !nearPlayer(block.position) ? 0 : 100);
                    } else {
                        setWalking(bot);
                        if (action.stationName && bot.pathfinder.movements) {
                            bot.pathfinder.movements.allowParkour = false;
                            bot.pathfinder.movements.maxDropDown = 1;
                        }
                        bot.pathfinder.setGoal(goal);
                    }
                }
                const base = pos().floored();
                if (now - action.walkAt >= 1800 && wood && (action.cleared ?? 0) < 2
                    && !nearPlayer(feet) && drop.position.distanceTo(pos()) < 4 && base.y <= feet.y + 2) {
                    const leaf = spots.flatMap(point => [point.offset(0,1,0), point]).map(point => bot.blockAt(point))
                        .find(block => foliage(block) && bot.canDigBlock(block) && inSight(block) && !(block.position.x === base.x
                            && block.position.z === base.z && block.position.y < base.y));
                    if (leaf) {
                        action.cleared = (action.cleared ?? 0) + 1;
                        action.digging = true;
                        bot.pathfinder.setGoal(null);
                        void bot.dig(leaf, true).then(() => {
                            if (!actionValid(action)) return;
                            action.digging = false;
                            action.landing = undefined;
                            action.until = performance.now() + 5000;
                        }).catch(error => { if (actionValid(action)) { diamond.blocked(error.message); cancel(1500); } });
                    }
                }
            }
            if (!job.resource || job.digging) return true;
            const action = job, point = action.target, block = bot.blockAt(point);
            if (!block || !bot.canDigBlock(block)) return true;
            if (action.flatLog && !flatLogStands(point).some(stand => stand.equals(groundCell()))) return true;
            if (!inSight(block)) {
                const leaf = !action.mining && firstHit(block, eye(bot.entity));
                if (!logCover(leaf, groundCell(), action.restock && block.name === 'mangrove_log')
                    || !bot.canDigBlock(leaf) || (action.cleared ?? 0) >= 3) return true;
                action.cleared = (action.cleared ?? 0) + 1;
                action.digging = true;
                bot.pathfinder.setGoal(null);
                void bot.dig(leaf, true).then(() => {
                    if (actionValid(action)) { action.digging = false; action.until = performance.now() + 7000; }
                }).catch(error => { if (actionValid(action)) { diamond.blocked(error.message); cancel(1500); } });
                return true;
            }
            if (!naturalResource(point, action.mining)) { cancel(); return false; }
            action.digging = true;
            bot.pathfinder.setGoal(null);
            void (async () => {
                const pick = inventory().filter(i => i.name.endsWith('_pickaxe')).sort((a,b) => pickTier(b.name) - pickTier(a.name))[0];
                if (action.mining && !pick) throw new Error();
                if (action.mining && bot.heldItem?.name !== pick.name) await bot.equip(pick, 'hand');
                if (!actionValid(action) || !naturalResource(point, action.mining) || urgent(threatList()).length) return;
                action.material = action.mining ? /^(cobblestone|cobbled_deepslate)$/ : /_log$/;
                action.collectedAtStart = inventory().filter(i => action.material.test(i.name)).reduce((n,i) => n + i.count, 0);
                await bot.dig(block, true);
                if (!actionValid(action)) return;
                log(`Gear mined: ${block.name}`);
                action.digging = false;
                action.resource = false;
                action.type = 'collect_gear';
                action.until = performance.now() + (action.mining ? 4500 : 8000);
                change({ type: 'collect_gear', target: coords(point) });
            })().catch(error => { if (actionValid(action)) { log(`Gear dig failed: ${error.message}`); cancel(1500); } });
            return true;
        }
        if (now < nextGear || typeof bot.recipesFor !== 'function' || urgent(threats).length) return false;
        const items = inventory();
        const { stationPoint } = diamond.stations();
        const station = localStation(stationPoint, 'crafting_table');
        const rememberedTable = stationPoint && bot.blockAt(stationPoint);
        const knownTable = stationPoint && (!rememberedTable || rememberedTable.name === 'crafting_table');
        const next = forceWood ? { wood: true } : gearPlan(knownTable ? [...items, { name: 'crafting_table', count: 1 }] : items, {
            furnaceReady: Boolean(localStation(diamond.stations().furnacePoint, 'furnace')) || items.some(i => i.name === 'furnace'),
            woodPickFirst: diamond.tableRecovery()?.phase === 'rebuild',
        });
        if (!next) return false;
        nextGear = now + 1500;
        if (!forceWood && next.wood && (woodFailures >= 2 || woodTrip)) {
            nextGear = now;
            return gatherSpareWood(now, threats);
        }
        if (next.craft || next.tool) {
            const name = next.craft ?? next.tool;
            const id = bot.registry.itemsByName[name]?.id;
            if (id === undefined) return false;
            const material = items.find(i => i.name === 'crafting_table');
            if (next.tool && !station && !material) {
                if (knownTable && reachWorkstation(stationPoint, 'crafting_table', now)) return true;
                diamond.blocked(`No safe surface to place the crafting table for ${name}`);
                return false;
            }
            const action = begin('craft_gear', 'gear', name, 8000);
            perform(action, async () => {
                const workbench = next.tool ? station ?? await workstation('crafting_table', action) : undefined;
                if (next.tool && !workbench) return;
                const recipe = bot.recipesFor(id, null, 1, workbench)[0];
                if (recipe && actionValid(action)) await bot.craft(recipe, 1, workbench);
                if (workbench && actionValid(action)) packWorkstation(workbench);
            }, 500);
            return true;
        }
        const gathering = gatherResource(now, items, next.mine, { forceWood, searching });
        if (!gathering && !next.mine && !forceWood) nextGear = now;
        return gathering;
    }
    function gatherResource(now, items, mining, { forceWood = false, searching = false, stockpiling = false } = {}) {
        const material = mining ? (stockpiling ? cobbleMaterial : /^(cobblestone|cobbled_deepslate|blackstone)$/) : /_log$/;
        for (const [key, until] of missedGear) if (now >= until) missedGear.delete(key);
        const available = point => !missedGear.has(point.toString());
        const dropped = bot.nearestEntity?.(e => e.position.distanceTo(pos()) < (searching ? 4 : 8)
            && (!searching || Math.abs(e.position.y - pos().y) < 1.25) && available(e.position.floored())
            && !nearPlayer(e.position) && material.test(e.getDroppedItem?.()?.name ?? ''));
        if (dropped) {
            const point = dropped.position.floored();
            const action = begin('collect_gear', 'gear', point, 8000);
            action.drop = dropped;
            action.material = material;
            action.collectedAtStart = items.filter(i => material.test(i.name)).reduce((n,i) => n + i.count, 0);
            return true;
        }
        const candidates = bot.findBlocks({ maxDistance: forceWood ? 20 : 12, count: 48, matching: b =>
            mining ? /^(stone|deepslate)$/.test(b?.name) : logName(b?.name) })
            .filter(point => {
                if (!available(point) || !naturalResource(point, mining)) return false;
                const block = bot.blockAt(point);
                return !searching || forestLog.test(block.name)
                    || block.name === 'mangrove_log' && bot.canDigBlock(block) && inSight(block);
            })
            .sort((a,b) => a.distanceTo(pos()) + (mining ? 0 : 1.5 * Math.max(0, a.y - pos().y))
                - b.distanceTo(pos()) - (mining ? 0 : 1.5 * Math.max(0, b.y - pos().y)));
        const fresh = point => mining || !lastStalledTree || now >= lastStalledTree.until
            || Math.hypot(point.x - lastStalledTree.point.x, point.z - lastStalledTree.point.z) > 2;
        const flat = !mining && candidates.find(point => fresh(point) && flatLogStands(point).some(feet => {
            const block = bot.blockAt(point);
            const hit = firstHit(block, feet.offset(0.5, bot.entity.eyeHeight ?? 1.65, 0.5));
            return hit?.position.equals(point) || logCover(hit, feet, forceWood && block.name === 'mangrove_log');
        }));
        const target = flat || candidates.find(point => {
            const block = bot.blockAt(point);
            return bot.canDigBlock(block) && inSight(block);
        }) || candidates.find(fresh);
        if (!target) {
            diamond.blocked(stockpiling ? 'No accessible stone nearby to stock spare cobble'
                : mining ? 'No accessible surface stone; looking for a safe staircase' : 'No accessible natural logs nearby');
            if (forceWood) woodFailures++;
            return mining && !stockpiling && (descend(now, Math.max(-58, groundCell().y - 1), false)
                || seekStoneEntrance(now) || descendCanopyVines(now));
        }
        diamond.blocked();
        const action = begin(mining ? 'mine_gear' : 'gather_gear', 'gear', target, 13_000);
        action.resource = true;
        action.mining = mining;
        action.restock = forceWood;
        action.flatLog = Boolean(flat);
        setWalking(bot);
        const goal = new goals.GoalNear(target.x, target.y, target.z, 4);
        goal.isEnd = node => {
            const block = bot.blockAt(target);
            const feet = new Vec3(node.x, node.y, node.z);
            const from = feet.offset(0.5, bot.entity.eyeHeight ?? 1.65, 0.5);
            if (action.flatLog && !flatLogStands(target).some(stand => stand.equals(feet))) return false;
            if (!block?.diggable || !grounded(feet, mining ? air : woodTrail)
                || from.distanceTo(target.offset(0.5,0.5,0.5)) > 4.5) return false;
            const hit = firstHit(block, from);
            return hit?.position.equals(target) || !mining && logCover(hit, feet, forceWood && block.name === 'mangrove_log');
        };
        bot.pathfinder.setGoal(goal);
        return true;
    }
    function flatLogStands(point) {
        const floor = bot.blockAt(point.offset(0,-1,0));
        if (!stationSupport(floor) || !ground.test(floor.name) || !dryNeighborhood(bot, point)) return [];
        return offsets.slice(0,4).map(([x,z]) => point.offset(x,0,z)).filter(stand => spawnGround(stand));
    }
    function localStation(point, name) {
        const block = point && bot.blockAt(point);
        return block?.name === name && block.position.distanceTo(pos()) < 4.5 && inSight(block) && !nearPlayer(point) ? block : undefined;
    }
    function stationReference(point, obstruction) {
        return stationFaces.map(face => ({ face, reference: bot.blockAt(point.minus(face)) }))
            .find(({ reference }) => stationSupport(reference) && (inSight(reference) || obstruction && inSight(obstruction)));
    }
    function stationClearance(point) {
        const player = pos();
        return !nearPlayer(point) && (player.y >= point.y + 1 || point.y >= player.y + 1.8
            || Math.abs(player.x - point.x - 0.5) >= 0.8 || Math.abs(player.z - point.z - 0.5) >= 0.8);
    }
    const stableStationGround = point => {
        const block = bot.blockAt(point);
        return stationSupport(block) && !fallingBlock.test(block.name) && !block.getProperties?.().waterlogged;
    };
    const stationSides = point => offsets.slice(0,4).map(([x,z]) => point.offset(x,0,z));
    const stationAwayFromDrop = point => stationSides(point).every(side =>
        [0,-1,-2,-3].some(y => stableStationGround(side.offset(0,y,0))));
    const stationPickupGround = point => [point, ...stationSides(point)]
        .every(cell => stableStationGround(cell.offset(0,-1,0)));
    async function workstation(name, action, blocksPlacement = threats => urgent(threats).length > 0) {
        const { stationPoint, furnacePoint } = diamond.stations();
        const point = name === 'furnace' ? furnacePoint : stationPoint;
        const existing = localStation(point, name);
        if (existing) return existing;
        const material = inventory().find(i => i.name === name);
        if (!material) return;
        const feet = groundCell();
        const adjacent = offsets.slice(0,4).map(([x,z]) => feet.offset(x,0,z));
        const sites = [1,2,3].flatMap(range => [0,-1,1].flatMap(y => (range === 1 ? offsets.slice(0,4) : offsets)
            .map(([x,z]) => feet.offset(x*range,y,z*range))));
        const active = () => actionValid(action) && !blocksPlacement(threatList());
        const place = async (item, target, allowWater = false) => {
            const replaceable = () => {
                const block = bot.blockAt(target);
                return stationClearance(target) && (item !== material || stationAwayFromDrop(target))
                    && (air(block) || allowWater && block?.name === 'water');
            };
            if (!active() || !replaceable() || !stationReference(target)) return false;
            await bot.equip(item, 'hand');
            const anchor = active() && replaceable() && stationReference(target);
            if (!anchor) return false;
            try { await bot.placeBlock(anchor.reference, anchor.face); }
            catch (error) {
                if (active() && bot.blockAt(target)?.name !== item.name)
                    log(`Workstation placement: ${item.name} at ${target} rejected (${error.code ?? error.name})`);
            }
            return bot.blockAt(target)?.name === item.name;
        };
        const placeStation = async target => {
            const below = bot.blockAt(target.offset(0,-1,0));
            const floor = air(below) ? bot.blockAt(target.offset(0,-2,0)) : below;
            if (!stationSupport(floor) || floor.getProperties?.().waterlogged) return;
            if (!await place(material, target)) return;
            diamond.station(name, target);
            diamond.blocked();
            return bot.blockAt(target);
        };
        sites.sort((a,b) => Number(stationPickupGround(b)) - Number(stationPickupGround(a)));
        for (const target of sites) {
            const station = await placeStation(target);
            if (station || !active()) return station;
        }
        const baseMaterial = inventory().find(item => item.name === 'dirt')
            ?? inventory().find(item => /_planks$/.test(item.name));
        if (baseMaterial) {
            for (const base of adjacent.flatMap(point => [point.offset(0,-1,0), point])) {
                const target = base.offset(0,1,0);
                if (!air(bot.blockAt(target)) || !stationClearance(target) || !stationAwayFromDrop(target)
                    || !await place(baseMaterial, base, true)) continue;
                const station = await placeStation(target);
                if (station || !active()) return station;
                break;
            }
        }
        for (const target of adjacent.flatMap(point => [point.offset(0,-1,0), point])) {
            const block = bot.blockAt(target);
            if (!active()) return;
            if (!stationClearance(target) || !stationAwayFromDrop(target) || !(stationSoil.test(block?.name) || foliage(block))
                || block.getProperties?.().waterlogged || !bot.canDigBlock(block) || !inSight(block)
                || !dryNeighborhood(bot, target) || !stationReference(target, block)) continue;
            action.digging = true;
            try { await bot.dig(block, true); }
            finally { action.digging = false; }
            const station = await placeStation(target);
            if (station || !active()) return station;
        }
        const step = adjacent.find(point => grounded(point, woodTrail) && directWalkSafe(point.offset(0.5,0,0.5)));
        if (step && active() && directWalk(action, step.offset(0.5,0,0.5))) {
            while (active() && action.walkingDirect) await wait(50);
            const station = await placeStation(feet);
            if (station || !active()) return station;
        }
        if (active() && bot.entity.onGround && typeof bot.setControlState === 'function'
            && [0,1,2,3].every(y => air(bot.blockAt(feet.offset(0,y,0)))) && stationReference(feet)) {
            await bot.equip(material, 'hand');
            if (!active()) return;
            bot.setControlState('jump', true);
            try {
                for (let i = 0; i < 12 && active() && !stationClearance(feet); i++) await wait(50);
                const station = await placeStation(feet);
                if (station || !active()) return station;
            } finally { if (actionValid(action)) bot.setControlState('jump', false); }
        }
        if (active()) diamond.blocked(`No safe support, slot, or base for ${name}`);
    }
    function progressCraft(name, spare = reserveWood) {
        const cost = bedName.test(name) ? 3 : craftingWoodCost[name] ?? 0;
        const items = inventory();
        if (cost && woodUnits(items) < spare + cost) return gatherSpareWood(performance.now(), []);
        if (cost && countPlanks(items) < cost) {
            const log = items.find(item => logName(item.name));
            if (log) return progressCraft(log.name.replace(/_log$/, '_planks'), spare);
        }
        const action = begin('craft_goal', 'diamond', name, 8000);
        perform(action, async () => {
            const handCraft = name === 'stick' || name === 'crafting_table' || name === 'flint_and_steel' || /_planks$/.test(name);
            const table = handCraft ? undefined : await workstation('crafting_table', action);
            if ((!handCraft && !table) || !actionValid(action)) return;
            const id = bot.registry.itemsByName[name]?.id;
            const recipe = bot.recipesFor(id, null, 1, table)[0];
            if (recipe) await bot.craft(recipe, 1, table);
            else diamond.blocked(`Missing recipe supplies for ${name}`);
            if (name === 'shield' && actionValid(action)) {
                const shield = inventory().find(item => item.name === 'shield');
                if (shield) await bot.equip(shield, 'off-hand');
            }
            if (table && actionValid(action)) packWorkstation(table);
        }, 500);
        return true;
    }
    function prepareShield(now, safe) {
        if (hasShield() || typeof bot.getEquipmentDestSlot !== 'function' || typeof bot.equip !== 'function') return false;
        const items = inventory();
        const shield = items.find(item => item.name === 'shield');
        if (job?.type === 'equip_shield') return now < job.until;
        if (shield) {
            const action = begin('equip_shield', 'diamond', 'shield', 3000);
            perform(action, () => bot.equip(shield, 'off-hand'));
            return true;
        }
        if (!safe || !items.some(item => item.name === 'iron_ingot') || typeof bot.recipesFor !== 'function') return false;
        const { stationPoint } = diamond.stations();
        const hasTable = items.some(item => item.name === 'crafting_table') || localStation(stationPoint, 'crafting_table');
        const wood = woodUnits(items);
        if (wood < craftingWoodCost.shield + (hasTable ? 0 : craftingWoodCost.crafting_table)) return false;
        if (job?.type === 'craft_goal' && ['shield', 'crafting_table'].includes(job.target)) return true;
        if (job?.type === 'craft_goal' && /_planks$/.test(job.target)) return true;
        if (job?.type === 'pack_workstation' || job?.stationName || job?.window) return false;
        if (now < nextShieldCraft) return false;
        if (hasTable && countPlanks(items) >= craftingWoodCost.shield) nextShieldCraft = now + 8000;
        return progressCraft(hasTable ? 'shield' : 'crafting_table', 0);
    }
    function bedBlocks(record) {
        if (record?.dimension !== bot.game?.dimension || !record) return [];
        return [bot.blockAt(toVec(record.foot)), bot.blockAt(toVec(record.head))];
    }
    function bedSite(origin, name, base) {
        const terrain = point => {
            const block = bot.blockAt(point);
            return stationSupport(block) && !fallingBlock.test(block.name) && !block.getProperties?.().waterlogged;
        };
        const sites = [];
        const radius = base ? 5 : 3;
        for (let x = -radius; x <= radius; x++) for (let z = -radius; z <= radius; z++) for (const y of base ? [0,1,-1,2,-2] : [0]) {
            const stand = origin.offset(x,y,z);
            if (base && horizontal(stand, base) > 24) continue;
            if (!grounded(stand) || !dryNeighborhood(bot, stand) || nearPlayer(stand)) continue;
            for (const [dx,dz] of offsets.slice(0,4)) {
                const foot = stand.offset(dx,0,dz), head = foot.offset(dx,0,dz);
                if (![foot, head].every(point => !nearPlayer(point) && terrain(point.offset(0,-1,0))
                    && terrain(point.offset(0,2,0)) && overheadStable(point) && dryNeighborhood(bot, point))) continue;
                const walls = [head.offset(dx,0,dz), ...[foot,head].flatMap(point =>
                    [-1,1].map(side => point.offset(dz*side,0,dx*side)))];
                if (walls.filter(point => terrain(point) && terrain(point.offset(0,1,0))).length < 3) continue;
                const cells = [foot.offset(0,1,0), foot, head.offset(0,1,0), head].map(point => bot.blockAt(point));
                if (!cells.every(block => air(block) || block?.name === name
                    || diggableGround.test(block?.name ?? '') && ascentSafe(block))) continue;
                const obstruction = cells.find(block => !air(block) && block.name !== name);
                sites.push({ stand, foot, head, obstruction, score: stand.distanceTo(origin) + (obstruction ? 4 : 0) });
            }
        }
        return sites.sort((a,b) => a.score - b.score)[0];
    }
    const canSetBedSpawn = () => typeof bot.sleep === 'function' && typeof bot._placeBlockWithOptions === 'function'
        && bot.game?.dimension === 'overworld';
    const savedBaseBedPending = () => {
        const spawn = diamond.spawnRelocation();
        return spawn?.base && canSetBedSpawn() && !diamond.bed()?.spawnSet
            && (spawn.bedSearchStartedAt == null || Date.now() - spawn.bedSearchStartedAt < bedSearchTimeout);
    };
    function prepareBed(now, safe, required = false, readyOnly = false) {
        if (!canSetBedSpawn()) return false;
        let record = diamond.bed();
        const blocks = bedBlocks(record);
        if (blocks.some(block => block && block.name !== record.name)) {
            diamond.setBed(null);
            record = null;
        }
        if (job?.kind === 'bed') {
            if (!safe || now >= job.until || stalled(job, now)) {
                if (job.sheep) missedSheep.set(job.sheep.id, now + 45_000);
                nextBedAttempt = now + 3000;
                cancel();
            } else if (job.type === 'hunt_sheep') {
                const sheep = job.sheep;
                if (sheep.isValid === false || !bot.entities?.[sheep.id]) cancel();
                else if (!job.swinging && now >= nextBedHit && canHit(sheep)) {
                    const action = job;
                    action.swinging = true;
                    nextBedHit = now + 900;
                    void bot.lookAt(eye(sheep), true).then(() => {
                        if (actionValid(action) && sheepHuntSafe(bot, sheep) && canHit(sheep)) bot.attack(sheep);
                    }).catch(() => {}).finally(() => { action.swinging = false; });
                }
            }
            return true;
        }
        const base = diamond.spawnRelocation()?.base;
        const items = inventory();
        const bed = items.find(item => bedName.test(item.name));
        const wool = new Map();
        for (const item of items) if (woolName.test(item.name)) wool.set(item.name, (wool.get(item.name) ?? 0) + item.count);
        const ready = [...wool].find(([,count]) => count >= 3);
        const readyToCraft = ready && countPlanks(items) >= 3;
        if (!safe || job || record?.spawnSet || !eligible() || now < nextBedAttempt) return false;
        if (readyOnly && !record && !bed && !readyToCraft) return false;
        if (!base && !hasShield() && !record && !bed && !readyToCraft) return false;
        const origin = groundCell();
        if (record?.dimension === bot.game.dimension && blocks.every(block => block?.name === record.name) && blocks.length) {
            const time = bot.time?.timeOfDay;
            if ((time >= 12541 && time <= 23458 || bot.isRaining && bot.thunderState > 0) && !threatList(9).length) {
                const stand = toVec(record.stand);
                if (Math.abs(stand.y - origin.y) > 2 || stand.distanceTo(origin) > 3) {
                    begin('return_to_bed', 'bed', stand, 8000);
                    walk(stand);
                } else {
                    const action = begin('sleep_in_bed', 'bed', blocks[0].position, 5000);
                    nextBedAttempt = now + 10_000;
                    perform(action, async () => {
                        await bot.sleep(blocks[0]);
                        if (!actionValid(action) || !bot.isSleeping) return;
                        diamond.setBed({ ...record, spawnSet: true });
                        const spawn = diamond.spawnRelocation();
                        if (spawn?.bedSearchStartedAt != null)
                            diamond.setSpawnRelocation({ ...spawn, bedSearchStartedAt: undefined });
                        diamond.blocked();
                        log(`Bed spawn set at ${blocks[0].position}`);
                    });
                }
                return true;
            }
            if (required) diamond.blocked('Waiting for a safe night to set bed spawn');
            return required;
        }
        if (record && blocks.some(block => !block)) {
            if (!required) return false;
            const stand = toVec(record.stand);
            if (stand.distanceTo(origin) <= 96 && Math.abs(stand.y - origin.y) <= 32) {
                begin('return_to_bed', 'bed', stand, 12_000);
                walk(stand);
                return true;
            }
            if (record.dimension === bot.game.dimension) return gatherSpareWood(now, []);
        }
        if (!nearSurface(origin)) return required && gatherSpareWood(now, []);
        if (bed) {
            if (base && horizontal(origin, base) > 24) {
                const point = toVec(base);
                if (point.distanceTo(origin) > 96 || Math.abs(point.y - origin.y) > 32) return false;
                begin('seek_bed_site', 'bed', point, 15_000);
                walk(point);
                return true;
            }
            const site = bedSite(origin, bed.name, base);
            if (!site) {
                if (!required) return false;
                diamond.blocked('Looking for a dry sheltered bed site');
                if (!pending) plan();
                return true;
            }
            if (!origin.equals(site.stand)) {
                begin('seek_bed_site', 'bed', site.stand, 8000);
                walk(site.stand);
            } else if (site.obstruction) {
                if (!mineProgress(site.obstruction, undefined, true)) nextBedAttempt = now + 5000;
            } else {
                const { stand, foot, head } = site;
                const action = begin('place_bed', 'bed', foot, 5000);
                nextBedAttempt = now + 5000;
                perform(action, async () => {
                    await bot.equip(bed, 'hand');
                    if (!actionValid(action) || !groundCell().equals(stand)
                        || ![foot,head].every(point => air(bot.blockAt(point)) && !capOccupant(point))) return;
                    const direction = head.minus(foot);
                    await bot.lookAt(eye(bot.entity).plus(direction), true);
                    if (!actionValid(action)) return;
                    await bot._placeBlockWithOptions(bot.blockAt(foot.offset(0,-1,0)), stationFaces[0],
                        { forceLook: 'ignore', swingArm: 'right' });
                    if (!actionValid(action)) return;
                    const placed = { name: bed.name, foot: coords(foot), head: coords(head), stand: coords(stand),
                        dimension: bot.game.dimension, spawnSet: false };
                    if (bedBlocks(placed).every(block => block?.name === bed.name)) diamond.setBed(placed);
                });
            }
            return true;
        }
        if (ready) {
            const { stationPoint } = diamond.stations();
            if (!items.some(item => item.name === 'crafting_table') && !localStation(stationPoint, 'crafting_table')) {
                if (bot.blockAt(stationPoint ?? origin)?.name === 'crafting_table'
                    && reachWorkstation(stationPoint ?? origin, 'crafting_table', now)) return true;
                return woodUnits(items) >= craftingWoodCost.crafting_table + 3
                    ? progressCraft('crafting_table', 3) : gatherSpareWood(now, []);
            }
            return progressCraft(ready[0].replace(/_wool$/, '_bed'), 0);
        }
        const drop = bot.nearestEntity?.(entity => woolName.test(entity.getDroppedItem?.()?.name ?? '')
            && entity.position.distanceTo(pos()) <= 8 && !nearPlayer(entity.position) && !missedGear.has(entity.position.floored().toString()));
        if (drop) {
            const pickup = begin('collect_gear', 'gear', drop.position.floored(), 8000);
            pickup.drop = drop;
            pickup.material = woolName;
            pickup.collectedAtStart = [...wool.values()].reduce((a,b) => a+b, 0);
            return true;
        }
        const spawn = diamond.spawnRelocation();
        if (base && spawn.bedSearchStartedAt == null)
            diamond.setSpawnRelocation({ ...spawn, bedSearchStartedAt: Date.now() });
        for (const [id, until] of missedSheep) if (now >= until) missedSheep.delete(id);
        const keys = bot.registry?.entitiesByName?.sheep?.metadataKeys ?? [];
        const eligibleSheep = entity => {
            const age = entity.metadata?.[keys.indexOf('baby')];
            const coat = entity.metadata?.[keys.indexOf('wool')];
            return entity.name === 'sheep' && entity.isValid !== false && age !== true && !(coat & 16)
                && entity.metadata?.[2] == null && entity.position.distanceTo(pos()) <= (base ? 36 : 20)
                && !missedSheep.has(entity.id) && !nearPlayer(entity.position) && sheepHuntSafe(bot, entity)
                && !offsets.slice(0,4).some(([x,z]) => /(?:fence|wall)$/.test(bot.blockAt(entity.position.floored().offset(x,0,z))?.name ?? ''));
        };
        const sheep = bot.nearestEntity?.(entity => eligibleSheep(entity)
            && wool.has(`${sheepColors[(entity.metadata?.[keys.indexOf('wool')] ?? 0) & 15]}_wool`))
            ?? bot.nearestEntity?.(eligibleSheep);
        const weapon = bestWeapon(items);
        if (sheep && weapon) {
            const action = begin('hunt_sheep', 'bed', sheep.position, 12_000);
            action.sheep = sheep;
            action.swinging = true;
            setWalking(bot);
            bot.pathfinder.setGoal(new goals.GoalFollow(sheep, 2), true);
            void bot.equip(weapon, 'hand').catch(() => { if (actionValid(action)) cancel(); })
                .finally(() => { action.swinging = false; });
            return true;
        }
        if (required) {
            diamond.blocked('Looking for sheep to gather three matching wool for a bed');
            if (!pending) plan();
        }
        nextBedAttempt = now + 2500;
        return required;
    }
    function packWorkstation(block) {
        const safeToPack = () => bot.entity.onGround && stationPickupGround(groundCell())
            && stationAwayFromDrop(block.position) && stationPickupGround(block.position);
        if (!block || !safeToPack() || !bot.canDigBlock(block)) return false;
        const name = block.name;
        const pick = name === 'furnace' && inventory().find(item => /_pickaxe$/.test(item.name));
        if (name === 'furnace' && !pick) return false;
        const action = begin('pack_workstation', 'diamond', block.position, 8000);
        action.digging = true;
        perform(action, async () => {
            if (pick) await bot.equip(pick, 'hand');
            if (!actionValid(action) || !safeToPack() || bot.blockAt(block.position)?.name !== name) return;
            await bot.dig(block, true);
            if (!actionValid(action)) return;
            const pickup = { ...action, digging: false, kind: 'gear', type: 'collect_gear',
                material: new RegExp(`^${name}$`), stationName: name, collectedAtStart: 0, until: performance.now() + 8000 };
            job = pickup;
            nextGear = pickup.until;
            change({ type: pickup.type, target: coords(block.position) });
        });
        return true;
    }
    function ascentSafe(block) {
        if (!block || nearPlayer(block.position) || !overheadStable(block.position) || !dryNeighborhood(bot, block.position)) return false;
        return ascentRock.test(block.name) || /^(?:deepslate_)?redstone_ore$/.test(block.name)
            && inventory().some(item => item.name.endsWith('_pickaxe') && pickTier(item.name) >= 3);
    }
    function overheadStable(point) {
        return [1,2,3].every(y => {
            const block = bot.blockAt(point.offset(0,y,0));
            return block && !fallingBlock.test(block.name);
        });
    }
    function jumpAscent(origin, point, clear, clearance, forest = true) {
        if (!bot.entity.onGround || typeof bot.lookAt !== 'function' || typeof bot.setControlState !== 'function') return false;
        const aim = point.offset(0.5,0,0.5);
        const safe = () => grounded(point, clear) && !nearPlayer(point) && overheadStable(origin) && overheadStable(point)
            && dryNeighborhood(bot, point) && clearance.every(cell => clear(bot.blockAt(cell)));
        if (!safe()) return false;
        const type = forest ? 'jump_up_step' : 'jump_to_vines';
        const label = forest ? 'Forest ascent' : 'Vine approach';
        const action = begin(type, forest ? 'forest' : 'diamond', point, 1800);
        if (forest) action.lastPosition = pos().clone();
        perform(action, async () => {
            await bot.lookAt(aim.offset(0, eye(bot.entity).y - aim.y, 0), true);
            if (!actionValid(action) || !groundCell().equals(origin) || !bot.entity.onGround || !safe()) return;
            bot.setControlState('jump', true);
            let advancing = false;
            for (let i = 0; i < 24 && actionValid(action) && safe(); i++) {
                if (bot.entity.onGround && groundCell().equals(point)) {
                    if (forest) failedForestEscapes = 0;
                    log(`${label}: landed on ${point}`);
                    return;
                }
                if (!advancing && pos().y >= point.y) {
                    advancing = true;
                    bot.setControlState('jump', false);
                    bot.setControlState('forward', true);
                } else if (advancing && Math.hypot(pos().x - aim.x, pos().z - aim.z) < 0.28) {
                    bot.setControlState('forward', false);
                }
                await wait(50);
            }
            if (actionValid(action)) {
                if (forest) failedForestEscapes++;
                const missed = forest ? missedAscent : missedStoneEntrances;
                missed.set(point.toString(), performance.now() + 45_000);
                log(`${label}: did not land on ${point}; trying a different cell`);
            }
        });
        return true;
    }
    function pillarForestEscape(toward, now) {
        if (failedForestEscapes < 2 || now < nextEscapePillar || typeof bot.placeBlock !== 'function'
            || typeof bot.equip !== 'function' || typeof bot.lookAt !== 'function' || typeof bot.setControlState !== 'function'
            || !bot.entity.onGround || forestLimit - woodTrip.walked < 7) return false;
        const base = groundCell();
        const safe = point => !nearPlayer(point) && dryNeighborhood(bot, point) && overheadStable(point);
        if (!grounded(base) || !stationSupport(bot.blockAt(base.offset(0,-1,0)))) return false;
        const items = inventory();
        const reserve = items.filter(item => defenseReserve.test(item.name)).reduce((sum,item) => sum + item.count, 0);
        let plan;
        for (const height of [3,4,5]) {
            const column = Array.from({ length: height + 3 }, (_, y) => base.offset(0,y,0));
            if (!column.every(point => air(bot.blockAt(point)) && safe(point))) break;
            const material = items.find(item => item.count >= height && (scaffoldMaterial.test(item.name) || item.name.endsWith('_planks'))
                && (!defenseReserve.test(item.name) || reserve - height >= defenseBlocks));
            if (!material) continue;
            const top = column[height];
            const exit = offsets.slice(0,4).flatMap(([x,z]) => [top.offset(x,0,z), top.offset(x,-1,z)])
                .filter(point => grounded(point, woodTrail) && safe(point)
                    && woodTrail(bot.blockAt(point.offset(0,2,0))) && point.distanceTo(toward) < top.distanceTo(toward))
                .sort((a,b) => a.distanceTo(toward) - b.distanceTo(toward))[0];
            if (exit) { plan = { height, material, top, exit }; break; }
        }
        if (!plan) return false;
        const { height, material, top, exit } = plan;
        const action = begin('pillar_forest_escape', 'forest', top, 12_000);
        action.lastPosition = pos().clone();
        nextEscapePillar = now + 30_000;
        const walkOff = async (point, arrived) => {
            const aim = point.offset(0.5,0,0.5);
            if (arrived()) return true;
            await bot.lookAt(aim.offset(0, eye(bot.entity).y - aim.y, 0), true);
            if (!actionValid(action) || !directWalkSafe(aim)) return false;
            bot.setControlState('forward', true);
            for (let i = 0; i < 24 && actionValid(action) && directWalkSafe(aim); i++) {
                if (arrived()) break;
                await wait(50);
            }
            if (!actionValid(action)) return false;
            bot.setControlState('forward', false);
            for (let i = 0; i < 8 && actionValid(action) && !arrived(); i++) await wait(50);
            return actionValid(action) && arrived();
        };
        perform(action, async () => {
            log(`Forest escape: pillaring ${height} blocks toward ${exit}`);
            const result = await climbPillar(bot, { base, height, material, active: () => actionValid(action), safe });
            if (!actionValid(action)) return;
            if (result.reason) {
                log(`Forest escape: pillar stopped after ${result.placed} blocks: ${result.reason}`);
                return;
            }
            if (safe(exit) && grounded(exit, woodTrail)
                && await walkOff(exit, () => bot.entity.onGround && groundCell().equals(exit))) {
                failedForestEscapes = 0;
                log(`Forest escape: walked off pillar onto ${exit}`);
            }
        });
        return true;
    }
    function climbStep(now, target, upOnly = false, forestEscape = false) {
        const origin = upOnly ? groundCell() : pos().floored();
        const rise = origin.y < target.y - 1 ? 1 : 0;
        const clear = block => air(block) || block?.name === 'vine' && block.boundingBox === 'empty';
        for (const [key, until] of missedAscent) if (now >= until) missedAscent.delete(key);
        const available = point => !missedAscent.has(point.toString()) && !nearPlayer(point);
        const choices = offsets.slice(0, 4).map(([x,z]) => origin.offset(x,rise,z))
            .filter(available)
            .filter(point => rise || point.distanceTo(target) < origin.distanceTo(target))
            .sort((a,b) => a.distanceTo(target) - b.distanceTo(target));
        const previous = diamond.previousStair(origin);
        if (rise && previous && available(previous) && previous.y >= origin.y && previous.y <= origin.y + 1
            && Math.abs(previous.x - origin.x) + Math.abs(previous.z - origin.z) === 1)
            choices.unshift(previous);
        for (const point of choices) {
            if (!overheadStable(origin) || !overheadStable(point)) continue;
            const floor = bot.blockAt(point.offset(0,-1,0));
            if (floor?.boundingBox !== 'block' || !ascentRock.test(floor.name)) continue;
            const rising = point.y > origin.y;
            const clearance = rising ? [origin.offset(0,2,0), origin.offset(0,3,0), point, point.offset(0,1,0), point.offset(0,2,0)]
                : [point, point.offset(0,1,0)];
            const blocks = clearance.map(p => bot.blockAt(p));
            if (!blocks.every(block => clear(block) || ascentSafe(block))) continue;
            const obstruction = blocks.find(block => !clear(block));
            if (obstruction) {
                if (mineProgress(obstruction, undefined, true)) return true;
                continue;
            }
            if (rising && forestEscape) {
                if (jumpAscent(origin, point, clear, clearance)) return true;
                continue;
            }
            begin(rising ? 'walk_up_step' : 'walk_level_step', 'diamond', point, 6500);
            walkStaircase(bot, setWalking, new goals.GoalBlock(point.x, point.y, point.z), undefined, upOnly, overheadStable);
            return true;
        }
        if (!rise) return false;
        const pillar = origin.offset(0,1,0);
        if (inventory().some(item => scaffoldMaterial.test(item.name)) && !missedAscent.has(pillar.toString()) && !nearPlayer(pillar)
            && overheadStable(origin) && overheadStable(pillar)) {
            const blocks = [pillar, pillar.offset(0,1,0), pillar.offset(0,2,0)].map(p => bot.blockAt(p));
            if (blocks.every(block => clear(block) || ascentSafe(block))) {
                const obstruction = blocks.find(block => !clear(block));
                if (obstruction) return mineProgress(obstruction, undefined, true);
                begin('walk_up_step', 'diamond', pillar, 6500);
                walkStaircase(bot, setWalking, new goals.GoalBlock(pillar.x, pillar.y, pillar.z), ascentSafe, upOnly, overheadStable);
                return true;
            }
        }
        return false;
    }
    function reachWorkstation(point, name, now, forPacking = false) {
        const table = point && bot.blockAt(point);
        if (!point || (table && table.name !== name)) return false;
        if (name === 'crafting_table' && !diamond.tableRecovery()?.phase)
            diamond.setTableRecovery({ phase: 'attempt', expires: Date.now() + tableAttemptMs });
        if (fallbackAscent) {
            if (climbStep(now, point)) return true;
            fallbackAscent = false;
        }
        const goal = new goals.GoalNear(point.x, point.y, point.z, 2);
        goal.isEnd = node => {
            const feet = new Vec3(node.x, node.y, node.z);
            const block = bot.blockAt(point);
            return block?.name === name && feet.distanceTo(point) < 4
                && (!forPacking || stationPickupGround(feet))
                && visibleFrom(block, feet.offset(0.5, bot.entity.eyeHeight ?? 1.65, 0.5));
        };
        const action = begin(name === 'crafting_table' ? 'walk_to_table' : 'walk_to_furnace', 'diamond', point, 8500);
        action.lastCell = pos().floored();
        walkStaircase(bot, setWalking, goal, ascentSafe, false, point.y > pos().y ? overheadStable : undefined);
        return true;
    }
    function recordForestTrip() {
        const recovery = diamond.tableRecovery();
        if (recovery?.phase === 'restock' && woodTrip)
            diamond.setTableRecovery({ ...recovery, forest: { ...woodTrip } });
    }
    function forestStep(toward, now, pickup) {
        const origin = groundCell();
        if ((!bot.entity.onGround && pos().y !== origin.y - 0.125) || !pickup && forestLimit - woodTrip.walked < 3) return false;
        for (const [key, until] of missedForestSteps) if (now >= until) missedForestSteps.delete(key);
        const ordinaryFloor = site => {
            const floor = bot.blockAt(site.offset(0,-1,0));
            return floor && ground.test(floor.name) && !floor.getProperties?.().waterlogged;
        };
        const stepKey = point => `${point.x},${point.z}`;
        const candidates = offsets.slice(0,4).flatMap(([x,z]) => [0,1,-1].map(y => origin.offset(x,y,z)))
            .filter(site => !missedForestSteps.has(stepKey(site)) && !nearPlayer(site) && ordinaryFloor(site) && grounded(site, woodTrail)
                && [origin, site].every(cell => woodTrail(bot.blockAt(cell.offset(0,2,0)))))
            .sort((a,b) => {
                const rank = point => point.distanceTo(toward) + (recentForestSteps.some(old => old.equals(point)) ? 6 : 0);
                return rank(a) - rank(b);
            });
        const point = candidates[0];
        if (!point) return false;
        recentForestSteps.push(origin);
        if (recentForestSteps.length > 8) recentForestSteps.shift();
        const action = pickup ?? begin('hop_forest', 'forest', point, 1400);
        if (pickup) {
            pickup.hops = (pickup.hops ?? 0) + 1;
            pickup.hopping = true;
            pickup.until = now + 6000;
            pickup.landing = undefined;
            bot.pathfinder.setGoal(null);
            log(`Pickup stalled: trying a short jump to ${point}`);
        } else {
            action.lastPosition = pos().clone();
            log(`Forest search: trying a short jump to ${point} after repeated stalls`);
        }
        const jump = async () => {
            const start = pos().clone();
            await bot.lookAt(new Vec3(point.x + 0.5, eye(bot.entity).y, point.z + 0.5), true);
            if (!actionValid(action)) return;
            bot.setControlState('jump', true);
            bot.setControlState('forward', true);
            for (let i = 0; i < 18 && actionValid(action); i++) {
                if (Math.hypot(pos().x - point.x - 0.5, pos().z - point.z - 0.5) < 0.35) break;
                await wait(50);
            }
            if (actionValid(action) && Math.hypot(pos().x - start.x, pos().z - start.z) < 0.5) {
                if (!pickup) failedForestEscapes++;
                missedForestSteps.set(stepKey(point), performance.now() + 60_000);
                log(`${pickup ? 'Pickup' : 'Forest'} jump made no progress toward ${point}; trying a different adjacent cell`);
            }
        };
        if (pickup) {
            void jump().catch(error => { if (actionValid(action)) log(`Pickup step skipped: ${error.name}`); })
                .finally(() => {
                    if (actionValid(action)) {
                        bot.clearControlStates();
                        action.hopping = false;
                    }
                });
        } else perform(action, jump, 400);
        return true;
    }
    function scanWoodland(origin, remaining, now) {
        if (now < nextBiomeScan) return forestTrunk ?? forestBearing;
        nextBiomeScan = now + 6000;
        forestBearing = undefined;
        forestTrunk = bot.findBlocks({
            point: origin, maxDistance: Math.min(36, remaining), count: 8,
            matching: block => forestLog.test(block.name),
            useExtraInfo: block => block.getProperties().axis === 'y'
                && Math.abs(block.position.y - origin.y) <= 10
                && ground.test(bot.blockAt(block.position.offset(0,-1,0))?.name ?? '')
                && bot.blockAt(block.position.offset(0,1,0))?.name === block.name,
        }).find(point => !nearPlayer(point));
        if (forestTrunk) return forestTrunk;
        return forestBearing = woodlandBiome(origin, remaining);
    }
    function biomeAt(point) {
        return bot.registry?.biomes?.[bot.world?.getBiome?.(point)]?.name ?? '';
    }
    function woodlandBiome(origin, remaining) {
        let bearing;
        const scan = Math.min(56, 8 * Math.floor(remaining / 8));
        for (let x = -scan; x <= scan; x += 8) for (let z = -scan; z <= scan; z += 8) {
            const point = origin.offset(x, 6, z);
            const distance = Math.hypot(x,z);
            if (distance < 8 || distance > scan || (bearing && horizontal(bearing, origin) <= distance)) continue;
            const wooded = y => forestBiome.test(biomeAt(point.offset(0,y,0)));
            if (wooded(0) && (wooded(-4) || wooded(4))) bearing = point;
        }
        return bearing;
    }
    function continueForestAscent(now, toward = forestAscent) {
        if (toward && groundCell().y < toward.y - 1 && forestLimit - woodTrip.walked >= 3
            && typeof bot.canDigBlock === 'function' && bot.world?.raycast && climbStep(now, toward, true, true)) {
            forestAscent = toward;
            return true;
        }
        forestAscent = undefined;
        return false;
    }
    function forestMovement(now) {
        if (now < nextForestRoute) return;
        nextForestRoute = now + 1500;
        const origin = groundCell();
        const remaining = forestLimit - woodTrip.walked;
        if (remaining < 4) {
            diamond.blocked('No accessible logs after the 300-block forest search');
            return;
        }
        const bearing = scanWoodland(origin, remaining, now);
        const dx = bearing && bearing.x - origin.x;
        const dz = bearing && bearing.z - origin.z;
        const bearingLength = Math.hypot(dx ?? 0, dz ?? 0);
        for (const [key, until] of missedForest) if (now >= until) missedForest.delete(key);
        for (const [key, until] of missedForestHeadings) if (now >= until) missedForestHeadings.delete(key);
        const found = [];
        for (const [x,z] of offsets) {
            const stride = Math.hypot(x,z);
            const direction = `${x},${z}`;
            let score = (direction === woodTrip.heading ? 8 : 0)
                + (bearingLength ? 22 * (x*dx + z*dz) / (stride * bearingLength) : 0);
            for (const distance of [6,12,20,30]) {
                if (distance > remaining - 1) break;
                const base = origin.offset(Math.round(x*distance/stride), 0, Math.round(z*distance/stride));
                if (base.distanceTo(toVec(woodTrip.origin)) > forestLimit) break;
                const point = [0,1,-1,2,-2,3,-3,4,-4,5,6,7,8].map(y => base.offset(0,y,0)).find(site => {
                    const floor = bot.blockAt(site.offset(0,-1,0));
                    return grounded(site, woodTrail) && floor && ground.test(floor.name);
                });
                if (!point) { score -= 6; continue; }
                const floor = bot.blockAt(point.offset(0,-1,0));
                score += floor.name === 'mud' ? 0 : 4;
                if (bot.blockAt(point.offset(0,3,0))?.name === 'mangrove_roots') score -= 4;
                if (nearPlayer(point) || missedForest.has(point.toString())) continue;
                const proximity = forestTrunk ? (origin.distanceTo(forestTrunk) - point.distanceTo(forestTrunk)) / 2 : 0;
                found.push({ point, direction, score: score + distance / 6 + proximity });
            }
        }
        const ranked = found.sort((a,b) => b.score - a.score);
        const best = ranked.find(candidate => !missedForestHeadings.has(candidate.direction)) ?? ranked[0];
        if (!best) {
            if (continueForestAscent(now, origin.offset(1024, 5, 0))) return;
            diamond.blocked('No new dry route out of the mangrove swamp');
            return;
        }
        woodTrip.heading = best.direction;
        const action = begin('seek_forest', 'forest', best.point, 22_000);
        action.lastPosition = pos().clone();
        action.direction = best.direction;
        log(`Forest search: heading=${best.direction} traveled=${woodTrip.walked.toFixed(1)}/${forestLimit} target=${best.point}${bearing ? ` woodland=${bearing}` : ''}`);
        setWalking(bot);
        if (bot.pathfinder.movements) {
            bot.pathfinder.movements.allowSprinting = bot.food >= 14;
            bot.pathfinder.movements.maxDropDown = 2;
        }
        bot.pathfinder.setGoal(new goals.GoalNear(best.point.x, best.point.y, best.point.z, 2));
    }
    function openAbove(point) {
        const top = (bot.game?.minY ?? -64) + (bot.game?.height ?? 384);
        for (let y = point.y + 2; y < top; y++) {
            const overhead = bot.blockAt(point.offset(0,y-point.y,0), false);
            const canopy = /^(?:mangrove_roots|muddy_mangrove_roots|moss_carpet)$/.test(overhead?.name)
                || logName(overhead?.name) || foliage(overhead);
            if (!overhead || (!canopy && overhead.boundingBox === 'block')) return false;
        }
        return true;
    }
    function nearSurface(feet, standingOnly = false) {
        if (standingOnly) return grounded(feet, woodTrail) && openAbove(feet);
        return [feet, ...offsets.map(([x,z]) => feet.offset(x,0,z))].some(base => [0,1,-1].some(y => {
            const point = base.offset(0,y,0);
            return grounded(point, woodTrail) && openAbove(point);
        }));
    }
    function spawnGround(point, dry = false) {
        const floor = bot.blockAt(point.offset(0,-1,0));
        const terrain = dry ? dryBaseSoil : ground;
        const clear = cell => {
            const block = bot.blockAt(cell);
            return woodTrail(block) && !block.getProperties?.().waterlogged;
        };
        return terrain.test(floor?.name ?? '') && floor.boundingBox === 'block'
            && !floor.getProperties?.().waterlogged && clear(point) && clear(point.offset(0,1,0))
            && !nearPlayer(point);
    }
    function spawnEdge(from, to) {
        if (!spawnGround(from) || !spawnGround(to) || Math.abs(to.y - from.y) > 1) return false;
        const clearance = to.y > from.y ? from.offset(0,2,0) : to.y < from.y ? to.offset(0,2,0) : null;
        return !clearance || (woodTrail(bot.blockAt(clearance)) && overheadStable(to));
    }
    function clearStalledBaseStep(origin, base) {
        if (night() || dusk() || typeof bot.dig !== 'function' || typeof bot.canDigBlock !== 'function'
            || !bot.world?.raycast || spawnLandingThreat(origin, 16)) return false;
        const drySoil = name => dryBaseSoil.test(name) || name === 'mud';
        const clearable = ({ point, rising }) => {
            const block = bot.blockAt(point);
            const floor = bot.blockAt(point.offset(0,-1,0));
            const upper = point.offset(0,1,0);
            const takeStep = rising ? woodTrail(bot.blockAt(origin.offset(0,2,0)))
                && woodTrail(bot.blockAt(upper)) && overheadStable(point) : spawnEdge(origin, upper);
            return takeStep && drySoil(block?.name) && drySoil(floor?.name) && stationSupport(floor) && !nearPlayer(point)
                && dryNeighborhood(bot, point) && !spawnLandingThreat(point, 16) && bot.canDigBlock(block) && inSight(block);
        };
        const candidate = offsets.slice(0,4).flatMap(([x,z]) => {
            const level = origin.offset(x,0,z), rise = level.offset(0,1,0);
            return [...(missedSpawnSteps.has(rise.toString()) ? [{ point: level, rising: false }] : []),
                { point: rise, rising: true }];
        }).filter(({ point }) => !missedSpawnSteps.has(point.toString()) && point.distanceTo(base) < origin.distanceTo(base))
            .sort((a,b) => a.point.distanceTo(base) - b.point.distanceTo(base)).find(clearable);
        if (!candidate) return false;
        const { point } = candidate;
        const action = begin('clear_stalled_base_step', 'spawn_escape', point, 5000);
        perform(action, async () => {
            if (!actionValid(action) || !groundCell().equals(origin) || spawnLandingThreat(origin, 16) || !clearable(candidate)) return;
            action.digging = true;
            await bot.dig(bot.blockAt(point), true);
            action.digging = false;
            if (actionValid(action) && spawnEdge(origin, point)) {
                log(`Cleared a dry ground step toward saved base at ${point}`);
                spawnWaypoints = [point];
            } else if (actionValid(action)) missedSpawnSteps.set(point.toString(), performance.now() + 30_000);
        });
        return true;
    }
    function clearBaseFoliage(origin, base) {
        if (night() || dusk() || typeof bot.canDigBlock !== 'function' || typeof bot.dig !== 'function'
            || !bot.world?.raycast || spawnLandingThreat(origin, 16)) return false;
        const blockedCell = point => {
            const floor = bot.blockAt(point.offset(0,-1,0));
            if (!ground.test(floor?.name ?? '') || !stationSupport(floor) || floor.getProperties?.().waterlogged
                || nearPlayer(point) || !overheadStable(point) || spawnLandingThreat(point, 16)) return;
            const blocks = [bot.blockAt(point), bot.blockAt(point.offset(0,1,0))];
            const clear = block => woodTrail(block) && !block.getProperties?.().waterlogged;
            if (!blocks.every(block => clear(block) || block && !block.getProperties?.().waterlogged
                && (block.name === 'mangrove_roots' || block.name.endsWith('_leaves') && !block.getProperties?.().persistent)
                && dryNeighborhood(bot, block.position))) return;
            return blocks.find(block => !clear(block) && bot.canDigBlock(block) && inSight(block));
        };
        const point = offsets.slice(0,4).map(([x,z]) => origin.offset(x,0,z))
            .filter(point => !missedSpawnSteps.has(point.toString())).sort((a,b) => a.distanceTo(base) - b.distanceTo(base))
            .find(blockedCell);
        if (!point) return false;
        const action = begin('clear_base_foliage', 'spawn_escape', point, 5000);
        perform(action, async () => {
            if (!actionValid(action) || !groundCell().equals(origin) || spawnLandingThreat(origin, 16)) return;
            const block = blockedCell(point);
            if (!block) return;
            action.digging = true;
            await bot.dig(block, true);
            action.digging = false;
            if (!actionValid(action)) return;
            if (woodTrail(bot.blockAt(block.position))) {
                log(`Cleared ${block.name} to open dry ground toward saved base at ${point}`);
                if (spawnEdge(origin, point)) spawnWaypoints = [point];
            } else missedSpawnSteps.set(point.toString(), performance.now() + 30_000);
        });
        return true;
    }
    function spawnRootFooting(point) {
        const floor = bot.blockAt(point.offset(0,-1,0));
        return /^(?:muddy_)?mangrove_roots$/.test(floor?.name ?? '') && stationSupport(floor)
            && !floor.getProperties?.().waterlogged && !nearPlayer(point);
    }
    function spawnRootEdge(from, to) {
        const drop = from.y - to.y;
        if (drop < 0 || drop > 3 || !spawnRootFooting(from)
            || !(spawnRootFooting(to) || spawnGround(to)) || !overheadStable(to)) return false;
        for (let y = to.y; y <= from.y + 1; y++) {
            const block = bot.blockAt(to.offset(0,y-to.y,0));
            if (!woodTrail(block) || block.getProperties?.().waterlogged) return false;
        }
        return drop > 0 || !spawnLandingThreat(to, 4);
    }
    function spawnRootRoute(origin, now) {
        const queue = [{ point: origin, path: [] }], seen = new Set([origin.toString()]);
        for (const { point, path } of queue) {
            if (path.length && spawnGround(point) && openAbove(point)) return path;
            if (path.length === 6) continue;
            for (const [x,z] of offsets.slice(0,4)) for (const y of [0,-1,-2,-3]) {
                const next = point.offset(x,y,z), key = next.toString();
                if (seen.has(key) || (missedSpawnSteps.get(key) ?? 0) > now || !spawnRootEdge(point, next)) continue;
                seen.add(key);
                queue.push({ point: next, path: [...path, next] });
            }
        }
    }
    function spawnRoute(origin, escape, now, limit = 8) {
        const start = toVec(escape.origin);
        const base = escape.destination && toVec(escape.destination);
        const distance = point => base && point.distanceTo(base);
        const forward = (point, [x,z]) => (point.x - origin.x) * x + (point.z - origin.z) * z;
        const directions = escape.heading ? [escape.heading] : offsets.slice(0,4);
        const woodland = !escape.heading && woodlandBiome(origin, spawnEscapeRange - horizontal(origin, start));
        const queue = [{ point: origin, path: [] }];
        const seen = new Set([origin.toString()]);
        let best;
        for (const node of queue) {
            if (node.path.length === limit) continue;
            for (const [x,z] of offsets.slice(0,4)) for (const y of [0,1,-1]) {
                const point = node.point.offset(x,y,z);
                const key = point.toString();
                if (seen.has(key) || (missedSpawnSteps.get(key) ?? 0) > now || horizontal(point, start) > spawnEscapeRange
                    || !spawnEdge(node.point, point)) continue;
                seen.add(key);
                const next = { point, path: [...node.path, point] };
                queue.push(next);
                if (base) {
                    const advance = distance(origin) - distance(point);
                    const score = 3 * advance - next.path.length;
                    if (advance > 0 && (!best || score > best.score)) best = { path: next.path, score };
                    continue;
                }
                for (const heading of directions) {
                    const advance = forward(point, heading);
                    if (advance <= 0) continue;
                    const preference = woodland ? 8 * forward(woodland, heading) / horizontal(woodland, origin) : 0;
                    const score = 3 * advance - next.path.length + Number(spawnGround(point, true)) + preference;
                    if (!best || score > best.score) best = { path: next.path, heading, score };
                }
            }
        }
        return best;
    }
    function atDryBase(point, distance) {
        if (!spawnGround(point, true) || !openAbove(point)) return false;
        const dryNeighbors = offsets.filter(([x,z]) => [0,1,-1].some(y => spawnGround(point.offset(x,y,z), true))).length;
        if (dryNeighbors < 4) return false;
        const biome = biomeAt(point);
        if (/swamp/.test(biome)) return false;
        return forestBiome.test(biome) || distance >= spawnEscapeRange - 8
            || Boolean(bot.findBlocks?.({ point, maxDistance: 18, count: 1, matching: block => forestLog.test(block.name) }).length);
    }
    function spawnLandingThreat(landing, radius = 12) {
        const center = landing.offset(0.5,0,0.5);
        let nearest, distance = radius;
        for (const entity of Object.values(bot.entities ?? {})) {
            if (entity.type !== 'hostile' || entity.isValid === false || !entity.position) continue;
            const range = entity.position.distanceTo(center);
            if (range <= distance) { nearest = entity; distance = range; }
        }
        return nearest;
    }
    function holdSpawnLedge(feet, landing) {
        const enemy = spawnLandingThreat(landing);
        if (!enemy && !night() && !dusk()) return false;
        const reason = enemy ? 'hostile within 12 blocks of landing' : 'waiting for daylight';
        if (job?.type !== 'hold_spawn_ledge' || !job.target.equals(landing)) {
            begin('hold_spawn_ledge', 'spawn_hold', landing, Infinity);
            job.nextDetour = performance.now() + 15_000;
            bot.setControlState('sneak', true);
        }
        const action = job;
        if (action.reason !== reason) {
            action.reason = reason;
            diamond.blocked(`Holding spawn ledge: ${reason}`);
            log(`Holding spawn ledge at ${feet} above ${landing}: ${reason}`);
        }
        const dirt = inventory().find(item => item.name === 'dirt');
        if (!enemy || action.sealAttempted || !dirt || typeof bot.equip !== 'function' || typeof bot.placeBlock !== 'function') return true;
        const wall = offsets.slice(0,4).map(([x,z]) => {
            const cell = feet.offset(x,0,z);
            const toward = x * (enemy.position.x - pos().x) + z * (enemy.position.z - pos().z);
            return { cell, toward };
        }).filter(({ cell, toward }) => toward > 0 && (cell.x !== landing.x || cell.z !== landing.z)
            && !nearPlayer(cell) && !capPlacement(cell).reason).sort((a,b) => b.toward - a.toward)[0];
        if (!wall) return true;
        action.sealing = action.sealAttempted = true;
        void (async () => {
            await bot.equip(dirt, 'hand');
            if (!actionValid(action) || !spawnLandingThreat(landing) || !groundCell().equals(feet)) return;
            const { reference, face, reason } = capPlacement(wall.cell);
            if (reason || nearPlayer(wall.cell)) return;
            await bot.placeBlock(reference, face);
            if (actionValid(action) && bot.blockAt(wall.cell)?.name === 'dirt')
                log(`Sealed exposed spawn ledge side with dirt at ${wall.cell}`);
        })().catch(error => { if (actionValid(action)) log(`Spawn ledge seal failed: ${error.message ?? error.name}`); })
            .finally(() => { action.sealing = false; });
        return true;
    }
    function walkSpawnStep(from, to, edge = spawnEdge, landing, waypoints = spawnWaypoints) {
        const action = begin('leave_hazardous_spawn', 'spawn_escape', to, 2500);
        action.spawnLanding = landing;
        perform(action, async () => {
            const aim = to.offset(0.5,0,0.5);
            await bot.lookAt(aim.offset(0, eye(bot.entity).y - aim.y, 0), true);
            if (!actionValid(action) || !groundCell().equals(from) || !edge(from,to)) return;
            if (landing && holdSpawnLedge(from, landing)) return;
            let advancing = to.y <= from.y;
            bot.setControlState(advancing ? 'forward' : 'jump', true);
            if (!advancing) bot.setControlState('forward', true);
            for (let i = 0; i < 32 && actionValid(action) && edge(from,to); i++) {
                const cell = groundCell();
                if (landing && bot.entity.onGround && cell.equals(from) && holdSpawnLedge(from, landing)) return;
                if ((cell.x !== from.x || cell.z !== from.z) && (cell.x !== to.x || cell.z !== to.z)) break;
                if (!advancing && pos().y >= to.y) {
                    advancing = true;
                    bot.setControlState('jump', false);
                }
                if (Math.hypot(pos().x - aim.x, pos().z - aim.z) <= 0.24) bot.setControlState('forward', false);
                if (bot.entity.onGround && cell.equals(to)) {
                    waypoints.shift();
                    return;
                }
                await wait(50);
            }
            if (actionValid(action)) {
                missedSpawnSteps.set(to.toString(), performance.now() + 30_000);
                waypoints.length = 0;
            }
        });
    }
    function spawnDigDrop(feet) {
        const point = feet.offset(0,-1,0);
        const block = bot.blockAt(point);
        if (!block || !(block.name.endsWith('_leaves') || logName(block.name)
            || /^(?:dirt|coarse_dirt|rooted_dirt|grass_block|podzol|mycelium)$/.test(block.name))
            || !stationSupport(block) || block.getProperties?.().waterlogged || nearPlayer(point)) return;
        if (!overheadStable(feet)) return;
        for (let drop = 1; drop <= 3; drop++) {
            const landing = feet.offset(0,-drop,0);
            if (nearPlayer(landing) || !dryNeighborhood(bot, landing)) return;
            const floor = bot.blockAt(landing.offset(0,-1,0));
            if (stationSupport(floor) && !fallingBlock.test(floor.name) && !floor.getProperties?.().waterlogged)
                return { block, landing };
            if (!air(floor)) return;
        }
    }
    function digSpawnCanopy(feet, now) {
        const drop = spawnDigDrop(feet);
        if (!drop || !bot.canDigBlock?.(drop.block) || typeof bot.dig !== 'function') return false;
        const { landing: target } = drop;
        if (holdSpawnLedge(feet, target)) return true;
        const center = feet.offset(0.5,0,0.5);
        const centered = () => Math.hypot(pos().x - center.x, pos().z - center.z) <= 0.14;
        const ready = () => bot.entity.onGround && groundCell().equals(feet);
        const action = begin('dig_spawn_canopy', 'spawn_escape', target, 9000);
        action.spawnLanding = target;
        perform(action, async () => {
            if (!centered()) {
                await bot.lookAt(center.offset(0,eye(bot.entity).y-center.y,0), true);
                if (!actionValid(action) || !ready()) return;
                bot.setControlState('sneak', true);
                bot.setControlState('forward', true);
                for (let i = 0; i < 45 && actionValid(action) && ready() && !centered(); i++) await wait(25);
                if (!actionValid(action)) return;
                bot.clearControlStates();
            }
            if (!ready() || !centered()) {
                log(`Spawn dig-down: could not center at ${feet}`);
                nextSpawnStep = now + 5000;
                return;
            }
            const planned = spawnDigDrop(feet);
            if (!planned?.landing.equals(target) || !bot.canDigBlock(planned.block) || holdSpawnLedge(feet, target)) return;
            const { block } = planned;
            action.digging = true;
            await bot.dig(block, true);
            action.digging = false;
            for (let i = 0; i < 40 && actionValid(action); i++) {
                if (bot.entity.onGround && groundCell().equals(target)) {
                    log(`Spawn dig-down: cleared ${block.name} and landed at ${target}`);
                    return;
                }
                await wait(50);
            }
            if (actionValid(action)) {
                log(`Spawn dig-down: did not confirm landing at ${target}`);
                nextSpawnStep = performance.now() + 3000;
            }
        });
        return true;
    }
    function approachSpawnDigColumn(feet, now) {
        const candidates = offsets.slice(0,4).flatMap(([x,z]) => [0,-1].map(y => feet.offset(x,y,z)))
            .filter(point => !missedSpawnSteps.has(point.toString()) && spawnDigDrop(point)
                && directWalkSafe(point.offset(0.5,0,0.5)));
        const target = candidates[0];
        if (!target) return false;
        const landing = target.y < feet.y ? target : undefined;
        if (landing && holdSpawnLedge(feet, landing)) return true;
        const action = begin('approach_spawn_dig_column', 'spawn_escape', target, 2500);
        action.spawnLanding = landing;
        if (directWalk(action, target.offset(0.5,0,0.5), () => {
            if (!groundCell().equals(target)) missedSpawnSteps.set(target.toString(), now + 30_000);
            cancel();
        }, () => actionValid(action) && (!landing || !bot.entity.onGround || !groundCell().equals(feet)
            || !holdSpawnLedge(feet, landing)))) return true;
        cancel();
        return false;
    }
    function canopyStep(from, to) {
        const rise = to.y - from.y;
        if (Math.abs(to.x - from.x) + Math.abs(to.z - from.z) !== 1 || rise < -3 || rise > 1
            || nearPlayer(to) || !overheadStable(to)) return;
        const floor = bot.blockAt(to.offset(0,-1,0));
        if (!stationSupport(floor) || fallingBlock.test(floor.name) || floor.getProperties?.().waterlogged) return;
        const clear = [];
        for (let y = Math.max(to.y,from.y) + 1; y >= to.y; y--) clear.push(to.offset(0,y-to.y,0));
        if (rise > 0) clear.unshift(from.offset(0,2,0));
        const cuts = [];
        for (const cell of clear) {
            const block = bot.blockAt(cell);
            if (!dryNeighborhood(bot, cell) || block?.getProperties?.().waterlogged) return;
            if (woodTrail(block)) continue;
            if (!block?.name.endsWith('_leaves')) return;
            cuts.push(cell);
        }
        return cuts;
    }
    function findCanopyDescent(origin, detour = false, destination) {
        const queue = [{ point: origin, path: [] }], seen = new Set([origin.toString()]);
        const levels = detour ? [0,-1,-2,-3,1] : [0,1];
        const distance = destination ? horizontal(origin, destination) : 0;
        let fallback, bestScore = 0;
        for (let index = 0; index < queue.length && index < 1200; index++) {
            const { point, path, high = true } = queue[index];
            const surface = ground.test(bot.blockAt(point.offset(0,-1,0))?.name ?? '') && openAbove(point);
            const landing = path.length && spawnDigDrop(point)?.landing;
            if (path.length && (detour
                ? (surface && point.y < origin.y && !spawnLandingThreat(point))
                    || (landing?.y < origin.y && !spawnLandingThreat(landing))
                : surface || landing?.y < origin.y)) return path;
            if (detour && destination && high) {
                const advance = distance - horizontal(point, destination);
                const score = advance - path.length / 5;
                if (advance >= 2 && score > bestScore) { fallback = path; bestScore = score; }
            }
            if (path.length === (detour ? 18 : 5)) continue;
            for (const [x,z] of offsets.slice(0,4)) for (const y of levels) {
                const next = point.offset(x,y,z), key = next.toString();
                if (seen.has(key) || missedSpawnSteps.has(key) || detour && spawnLandingThreat(next, y < 0 ? 12 : 4)
                    || !canopyStep(point, next)) continue;
                seen.add(key);
                queue.push({ point: next, path: [...path, next], high: high && y >= 0 });
            }
        }
        return fallback;
    }
    function approachCanopyDescent(feet) {
        if (typeof bot.dig !== 'function' || typeof bot.canDigBlock !== 'function') return false;
        if (!spawnCanopyRoute.length) spawnCanopyRoute = findCanopyDescent(feet) ?? [];
        const target = spawnCanopyRoute[0];
        if (!target) return false;
        const cuts = canopyStep(feet, target);
        if (!cuts) { spawnCanopyRoute = []; return false; }
        const landing = target.y < feet.y ? target : undefined;
        if (landing && holdSpawnLedge(feet, landing)) return true;
        const path = spawnCanopyRoute;
        const edge = (from, to) => canopyStep(from, to)?.length === 0;
        const walk = () => walkSpawnStep(feet, target, edge, landing, path);
        if (!cuts.length) { walk(); return true; }
        const action = begin('clear_spawn_canopy_step', 'spawn_escape', target, 5000);
        action.spawnLanding = landing;
        perform(action, async () => {
            for (const cell of cuts) {
                const block = bot.blockAt(cell);
                if (!actionValid(action) || !groundCell().equals(feet) || !canopyStep(feet, target)) break;
                if (woodTrail(block)) continue;
                if (!bot.canDigBlock(block) || (bot.world?.raycast && !inSight(block))) break;
                action.digging = true;
                await bot.dig(block, true);
                action.digging = false;
            }
            if (!actionValid(action)) return;
            if (edge(feet, target)) {
                log(`Cleared canopy step from ${feet} toward supported descent via ${target}`);
                walk();
            } else {
                missedSpawnSteps.set(target.toString(), performance.now() + 30_000);
                path.length = 0;
            }
        });
        return true;
    }
    function relocateSpawn(now, safe) {
        const spawn = diamond.spawnRelocation();
        const returning = spawn?.base && spawn.escape;
        if (!spawn || (!earlySpawnStage && !returning) || bot.game?.dimension !== 'overworld'
            || (spawn.exhausted && !returning) || typeof bot.lookAt !== 'function'
            || typeof bot.setControlState !== 'function') return false;
        const point = groundCell();
        for (const [key, until] of missedSpawnSteps) if (now >= until) missedSpawnSteps.delete(key);
        while (spawnStalls.length && now - spawnStalls[0] > spawnStallWindow) spawnStalls.shift();
        let escape = spawn.escape;
        if (!escape && spawn.base) return false;
        if (returning && !escape.destination) {
            escape = { origin: coords(point), destination: spawn.base };
            diamond.setSpawnRelocation({ ...spawn, escape });
            log(`Returning to saved jungle base at ${toVec(spawn.base)}`);
        }
        if (!escape) {
            const stalledNearSpawn = spawnStalls.length >= 3 && (!woodTrip || failedForestEscapes >= 2);
            const diedNearSpawn = (spawn.deaths ?? []).filter(at => Date.now() - at <= spawnDeathWindow).length >= 2;
            if (horizontal(point, spawn.origin) > spawnRadius || (!spawn.base && !stalledNearSpawn && !diedNearSpawn)) return false;
            escape = { origin: coords(point), heading: spawn.heading ?? null };
            diamond.setSpawnRelocation({ ...spawn, escape });
            log(`Leaving hazardous spawn near ${point}`);
        }
        if (job?.kind === 'spawn_hold') {
            if (holdSpawnLedge(point, job.target)) {
                if (now < job.nextDetour || job.sealing || !bot.entity.onGround
                    || night() || dusk() || urgent(threatList()).length) return true;
                job.nextDetour = now + 15_000;
                const path = findCanopyDescent(point, true, escape.destination);
                if (!path) {
                    if (!job.detourBlocked) log(`No dry ledge detour found from ${point} while the landing remains threatened`);
                    job.detourBlocked = true;
                    return true;
                }
                spawnCanopyRoute = path;
                log(`Bypassing threatened spawn landing via supported ledges toward ${path.at(-1)}`);
                approachCanopyDescent(point);
                return true;
            }
            cancel();
            diamond.blocked();
        }
        if (job?.kind === 'spawn_escape') {
            if (bot.entity.onGround && job.spawnLanding?.y < point.y && holdSpawnLedge(point, job.spawnLanding)) return true;
            if (now < job.until) return true;
            missedSpawnSteps.set(job.target.toString(), now + 30_000);
            spawnWaypoints = [];
            spawnCanopyRoute = [];
            cancel();
        }
        if (now < nextSpawnStep) return true;
        if (!bot.entity.onGround) return true;
        if (!spawnGround(point) || !openAbove(point)) {
            const canCrossCanopy = safe || !urgent(threatList()).length;
            if (canCrossCanopy && spawnCanopyRoute.length && approachCanopyDescent(point)) return true;
            if (digSpawnCanopy(point, now) || approachSpawnDigColumn(point, now)) return true;
            if (safe && spawnRootFooting(point)) {
                const route = spawnRootRoute(point, now);
                if (route) {
                    const landing = route[0].y < point.y ? route[0] : undefined;
                    if (landing && holdSpawnLedge(point, landing)) return true;
                    spawnWaypoints = route;
                    walkSpawnStep(point, route[0], spawnRootEdge, landing);
                    return true;
                }
            }
            if (canCrossCanopy) {
                if (approachCanopyDescent(point)) return true;
                if (!dusk() && !night()) {
                    spawnCanopyRoute = findCanopyDescent(point, true, escape.destination) ?? [];
                    if (spawnCanopyRoute.length && approachCanopyDescent(point)) return true;
                }
            }
            nextSpawnStep = now + 3000;
            diamond.blocked('Spawn dig-down blocked: no dry supported drop within three blocks or reachable canopy column');
            return true;
        }
        if (!safe) return true;
        const distance = horizontal(point, escape.origin);
        const base = returning && toVec(spawn.base);
        if (returning ? point.equals(base) || point.distanceTo(base) <= 2 && !spawnGround(base)
            : distance >= 24 && atDryBase(point, distance)) {
            if (!spawn.base && diamond.bed()) diamond.setBed(null);
            diamond.setSpawnRelocation({ ...spawn, escape: null, base: spawn.base ?? coords(point),
                heading: escape.heading ?? spawn.heading });
            spawnStalls.length = 0;
            spawnWaypoints = [];
            spawnCanopyRoute = [];
            cancel();
            diamond.blocked();
            if (returning) {
                diamond.finishDeathRecovery();
                log(`Returned to saved jungle base at ${point}`);
            } else log(`Dry surface base selected at ${point}; looking for a sheltered bed site nearby`);
            return false;
        }
        const waypoint = spawnWaypoints[0];
        if (waypoint && Math.abs(waypoint.x - point.x) + Math.abs(waypoint.z - point.z) === 1
            && spawnEdge(point, waypoint)) {
            walkSpawnStep(point, waypoint);
            return true;
        }
        const next = spawnRoute(point, escape, now) ?? (returning && spawnRoute(point, escape, now, 24));
        if (!next) {
            cancel();
            spawnWaypoints = [];
            if (base && (clearStalledBaseStep(point, base) || clearBaseFoliage(point, base))) return true;
            if (distance >= spawnEscapeRange) {
                diamond.setSpawnRelocation({ ...spawn, escape: null, exhausted: true });
                diamond.blocked('No dry base found within the 150-block spawn escape');
                return true;
            }
            nextSpawnStep = now + 3000;
            diamond.blocked(returning ? 'No dry ground route toward the saved base' : 'No dry ground route toward the spawn escape heading');
            return true;
        }
        if (!returning && !escape.heading) {
            escape = { ...escape, heading: next.heading };
            diamond.setSpawnRelocation({ ...spawn, escape });
            log(`Spawn escape heading: ${next.heading.join(',')}, up to ${spawnEscapeRange} blocks`);
        }
        spawnWaypoints = next.path;
        walkSpawnStep(point, spawnWaypoints[0]);
        return true;
    }
    function pillarForWood(now, base) {
        if (now < nextRestockPillar || !bot.entity.onGround || !pos().floored().equals(base)
            || typeof bot.placeBlock !== 'function' || typeof bot.equip !== 'function'
            || typeof bot.look !== 'function' || typeof bot.lookAt !== 'function'
            || typeof bot.setControlState !== 'function' || !stationSupport(bot.blockAt(base.offset(0,-1,0)))) return false;
        const items = inventory().filter(item => defenseReserve.test(item.name));
        const material = items.find(item => item.count > 0 && item.name === 'cobblestone') ?? items.find(item => item.count > 0);
        if (!material || items.reduce((sum,item) => sum + item.count, 0) <= defenseBlocks) return false;
        const safe = point => !nearPlayer(point) && overheadStable(point) && dryNeighborhood(bot, point);
        const column = [base, base.offset(0,1,0), base.offset(0,2,0)].map(point => bot.blockAt(point));
        if (!air(column[0]) || !column.every(block => block && safe(block.position))) return false;
        const obstruction = column.find(block => !air(block));
        if (obstruction) {
            if (!ascentSafe(obstruction) || !mineProgress(obstruction, undefined, true)) return false;
            restockPillarActive = true;
            return true;
        }
        restockPillarActive = true;
        const action = begin('pillar_wood_ascent', 'diamond', base.offset(0,1,0), 8000);
        perform(action, async () => {
            const { reason } = await climbPillar(bot, { base, height: 1, material, active: () => actionValid(action), safe });
            if (!actionValid(action)) return;
            if (reason) {
                nextRestockPillar = performance.now() + 15_000;
                log(`Wood restock pillar stopped at ${base}: ${reason}`);
            } else log(`Wood restock pillar: landed on ${action.target}`);
        });
        return true;
    }
    function stockDefenseBlocks(now) {
        for (const [key, until] of missedGear) if (now >= until) missedGear.delete(key);
        if (job?.kind === 'reserve') {
            if (now < job.until && !stalled(job, now)) return true;
            missedGear.set(job.target.toString(), now + 45_000);
            cancel();
        }
        const items = inventory();
        if (items.reduce((n,item) => n + (defenseReserve.test(item.name) ? item.count : 0), 0) >= defenseBlocks
            || typeof bot.findBlocks !== 'function' || typeof bot.canDigBlock !== 'function' || !bot.world) return false;
        if (job && (job.type === 'descend_vines' || job.type === 'seek_vine_descent'
            || job.type === 'jump_to_vines' || job.type === 'walk_to_vines'
            || job.kind === 'gear' && job.type === 'collect_gear')) return false;
        const feet = groundCell();
        const sites = bot.findBlocks({ maxDistance: 8, count: 32, matching: block => reserveSoil.test(block.name) });
        const dirt = sites.map(point => bot.blockAt(point)).find(block => block && reserveSoil.test(block.name)
            && !nearPlayer(block.position) && !missedGear.has(block.position.toString())
            && (block.position.y >= feet.y || Math.abs(block.position.x - feet.x) + Math.abs(block.position.z - feet.z) >= 2)
            && dryNeighborhood(bot, block.position) && overheadStable(block.position) && bot.canDigBlock(block) && inSight(block)
            && offsets.slice(0,4).some(([x,z]) => grounded(block.position.offset(x,0,z), woodTrail)
                || grounded(block.position.offset(x,1,z), woodTrail)));
        if (dirt) {
            const action = begin('gather_defense_dirt', 'reserve', dirt.position, 6500);
            action.digging = true;
            perform(action, async () => {
                const shovel = items.find(item => item.name.endsWith('_shovel'));
                if (shovel) await bot.equip(shovel, 'hand');
                if (!actionValid(action) || urgent(threatList()).length || !bot.canDigBlock(dirt)
                    || bot.blockAt(dirt.position)?.name !== dirt.name) return;
                action.collectedAtStart = inventory().reduce((n,item) => n + (item.name === 'dirt' ? item.count : 0), 0);
                await bot.dig(dirt, true);
                if (!actionValid(action)) return;
                action.type = 'collect_gear';
                action.kind = 'gear';
                action.digging = false;
                action.material = /^dirt$/;
                action.until = performance.now() + 4500;
                job = { ...action };
                change({ type: job.type, target: coords(job.target) });
            });
            return true;
        }
        if (job) return false;
        if (descendCanopyVines(now)) return true;
        if (items.some(item => item.name.endsWith('_pickaxe')) && !nearSurface(feet, true)) {
            const stone = bot.findBlocks({ maxDistance: 5, count: 16, matching: block => /^(?:stone|deepslate)$/.test(block.name) })
                .map(point => bot.blockAt(point)).find(block => block && !missedGear.has(block.position.toString())
                    && naturalResource(block.position, true) && dryNeighborhood(bot, block.position) && overheadStable(block.position));
            if (mineProgress(stone, cobbleMaterial)) return true;
        }
        const approach = sites.flatMap(point => offsets.slice(0,4).map(([x,z]) => point.offset(x,1,z)))
            .find(point => point.y >= feet.y - 2 && point.y <= feet.y + 2 && grounded(point, woodTrail)
                && !nearPlayer(point) && !missedGear.has(point.toString()) && point.distanceTo(feet) > 2);
        if (!approach) return false;
        begin('seek_defense_dirt', 'reserve', approach, 6500);
        walkStaircase(bot, setWalking, new goals.GoalBlock(approach.x, approach.y, approach.z));
        return true;
    }
    function recordTunnelStep(from, to) {
        if (!night() || nearSurface(to)) { tunnelSteps = 0; tunnelSeal = undefined; return; }
        if (++tunnelSteps >= 10) tunnelSeal = from;
    }
    function sealTunnel() {
        if (!night()) { tunnelSteps = 0; tunnelSeal = undefined; return false; }
        if (job?.type === 'seal_tunnel') return true;
        if (job || !tunnelSeal || typeof bot.placeBlock !== 'function') return false;
        const point = tunnelSeal;
        tunnelSeal = undefined;
        tunnelSteps = 0;
        const material = scaffold(2);
        if (!material || nearPlayer(point) || point.distanceTo(groundCell()) > 2 || !dryNeighborhood(bot, point)
            || !air(bot.blockAt(point)) || !air(bot.blockAt(point.offset(0,1,0))) || !sealAnchor(point)) return false;
        const action = begin('seal_tunnel', 'diamond', point, 4000);
        perform(action, async () => {
            await bot.equip(material, 'hand');
            for (const cell of [point, point.offset(0,1,0)]) {
                if (!actionValid(action) || nearPlayer(cell) || !air(bot.blockAt(cell))) return;
                const anchor = sealAnchor(cell);
                if (!anchor) return;
                await bot.placeBlock(anchor.reference, anchor.face);
                if (!stationSupport(bot.blockAt(cell))) return;
            }
        });
        return true;
    }
    function gatherSpareWood(now, threats) {
        if (forestAscent && continueForestAscent(now)) return true;
        const feet = groundCell();
        const top = (bot.game?.minY ?? -64) + (bot.game?.height ?? 384);
        const surface = restockPillarActive
            ? offsets.slice(0,4).some(([x,z]) => [0,1,-1].some(y => {
                const exit = feet.offset(x,y,z);
                return nearSurface(exit, true) && overheadStable(exit)
                    && (y <= 0 || air(bot.blockAt(feet.offset(0,2,0))));
            }))
            : nearSurface(feet);
        if (!surface) {
            if (pillarForWood(now, feet)) return true;
            if (climbStep(now, feet.offset(1024, top - feet.y, 0), true)) return true;
            for (const [x,z] of offsets.slice(0,4)) {
                if (!climbStep(now, feet.offset(x,1,z))) continue;
                if (job?.type === 'walk_level_step') missedAscent.set(feet.toString(), now + 45_000);
                return true;
            }
            diamond.blocked('No safe dry step toward the surface');
            return true;
        }
        restockPillarActive = false;
        woodTrip ??= diamond.tableRecovery()?.forest;
        const logs = countLogs(inventory());
        if (logs !== lastWoodCount) {
            lastWoodCount = logs;
            woodCheckedAt = now;
        }
        if (!woodTrip && (woodFailures >= 2 || now - woodCheckedAt >= 45_000)) {
            woodTrip = { origin: coords(feet), walked: 0 };
            recordForestTrip();
            log('Mangrove gathering stalled; looking for forest away from the swamp');
        }
        if (gear(now, threats, true, Boolean(woodTrip && woodTrip.walked < forestLimit))) return true;
        if (job?.type === 'wander' && (now >= job.until || stalled(job, now))) cancel();
        if (!job && !pending) {
            if (woodTrip) forestMovement(now);
            else plan(true);
        }
        return true;
    }
    function recoverWorkstation(point, name, now) {
        if (!point) return false;
        const drop = bot.nearestEntity?.(e => e.position.distanceTo(point) < 8 && stationPickupGround(e.position.floored())
            && (missedGear.get(e.position.floored().toString()) ?? 0) <= now
            && e.getDroppedItem?.()?.name === name && !nearPlayer(e.position));
        if (drop) {
            const pickup = begin('collect_gear', 'gear', drop.position.floored(), 8000);
            pickup.drop = drop;
            pickup.material = new RegExp(`^${name}$`);
            pickup.collectedAtStart = 0;
            pickup.stationName = name;
            return true;
        }
        return packWorkstation(localStation(point, name))
            || stationAwayFromDrop(point) && stationPickupGround(point) && reachWorkstation(point, name, now, true);
    }
    function rebuildTable(now, items, ironPick) {
        const has = name => items.some(item => item.name === name);
        const count = name => items.filter(item => item.name === name).reduce((total,item) => total + item.count, 0);
        const { stationPoint } = diamond.stations();
        const table = localStation(stationPoint, 'crafting_table');
        if (!has('crafting_table') && !table) {
            if (ironPick && recoverWorkstation(stationPoint, 'crafting_table', now)) return true;
            return progressCraft('crafting_table', 0);
        }
        if (!ironPick && count('iron_ingot') >= 3) {
            return progressCraft(count('stick') < 2 ? 'stick' : 'iron_pickaxe', 0);
        }
        if (table && packWorkstation(table)) return true;
        if (ironPick || has('stone_pickaxe')) diamond.setTableRecovery(null);
        return false;
    }
    function mineProgress(block, drops, clearingAscent = false) {
        if (!block || nearPlayer(block.position) || !canMine(bot, block, inSight)) return false;
        const pick = [...inventory()].filter(i => /_pickaxe$/.test(i.name))
            .sort((a,b) => pickTier(b.name) - pickTier(a.name))[0];
        if (!pick && (!clearingAscent || !ascentSafe(block))) return false;
        if (pick && ((/^(?:obsidian|ancient_debris)$/.test(block.name) && pickTier(pick.name) < 4)
            || (diamonds.test(block.name) && pickTier(pick.name) < 3)
            || (ironOre.test(block.name) && pickTier(pick.name) < 2))) return false;
        const timeout = pick ? 15_000 : Math.max(15_000, (bot.digTime?.(block) ?? 0) + 3000);
        const action = begin('mine_goal', 'diamond', block.position, timeout);
        action.digging = true;
        void (async () => {
            if (pick && bot.heldItem?.name !== pick.name) await bot.equip(pick, 'hand');
            if (!actionValid(action) || urgent(threatList()).length || !canMine(bot, bot.blockAt(block.position), inSight)
                || clearingAscent && !ascentSafe(bot.blockAt(block.position))
                || bot.blockAt(block.position).name !== block.name) { if (actionValid(action)) cancel(); return; }
            action.collectedAtStart = drops ? inventory().filter(i => drops.test(i.name)).reduce((n,i) => n + i.count, 0) : 0;
            await bot.dig(block, true);
            if (!actionValid(action)) return;
            action.digging = false;
            if (!drops) {
                if (fallingBlock.test(block.name)) await wait(750);
                if (actionValid(action)) cancel();
                return;
            }
            action.kind = 'gear';
            action.type = 'collect_gear';
            action.material = drops;
            action.until = performance.now() + 4500;
            change({ type: action.type, target: coords(block.position) });
        })().catch(error => { if (actionValid(action)) { diamond.blocked(error.message); cancel(1500); } });
        return true;
    }
    function seekStoneEntrance(now) {
        const origin = groundCell();
        if (!bot.pathfinder.movements || origin.y <= -58) return false;
        for (const [key, until] of missedStoneEntrances) if (now >= until) missedStoneEntrances.delete(key);
        const sites = [];
        for (let x = -8; x <= 8; x++) for (let z = -8; z <= 8; z++) for (let y = -6; y <= 2; y++) {
            if (x*x + z*z > 64 || y === 0 && x === 0 && z === 0) continue;
            const point = origin.offset(x,y,z);
            const floor = bot.blockAt(point.offset(0,-1,0));
            if (point.y > -58 && ground.test(floor?.name ?? '') && !floor.getProperties?.().waterlogged
                && grounded(point) && !missedStoneEntrances.has(point.toString()) && !nearPlayer(point)) sites.push(point);
        }
        const target = sites.sort((a,b) => a.distanceTo(origin) - b.distanceTo(origin)).find(point => {
            const from = point.offset(0.5, eye(bot.entity).y - pos().y - (bot.blockAt(point.offset(0,-1,0)).name === 'mud' ? 0.125 : 0), 0.5);
            const prospect = { blockAt: position => bot.blockAt(position), canDigBlock: block => block.diggable };
            return tunnelPlan(prospect, point.y - 1, null, block => visibleFrom(block, from), step => !nearPlayer(step), false, point);
        });
        if (!target) return false;
        begin('seek_stone_entrance', 'diamond', target, 8000);
        walkStaircase(bot, setWalking, new goals.GoalBlock(target.x, target.y, target.z));
        bot.pathfinder.movements.allowParkour = false;
        return true;
    }
    function descendCanopyVines(now) {
        const origin = groundCell();
        const floor = bot.blockAt(origin.offset(0,-1,0))?.name ?? '';
        if ((!logName(floor) && !floor.endsWith('_leaves')) || !bot.lookAt || !bot.setControlState) return false;
        if (!sameVineArea(origin)) vineStalls = 0;
        for (const [key, until] of missedStoneEntrances) if (now >= until) missedStoneEntrances.delete(key);
        const landing = entry => {
            if (!woodTrail(bot.blockAt(entry.offset(0,1,0)))) return;
            for (let drop = 0; drop <= 32; drop++) {
                const cell = entry.offset(0,-drop,0);
                if (grounded(cell, woodTrail)) {
                    const support = bot.blockAt(cell.offset(0,-1,0));
                    if (drop >= 3 && (ground.test(support.name) || foliage(support))
                        && dryNeighborhood(bot, cell) && !nearPlayer(cell)) return cell;
                    return;
                }
                if (bot.blockAt(cell)?.name !== 'vine' || nearPlayer(cell)) return;
            }
        };
        let best, score = Infinity;
        for (let dx = -5; dx <= 5; dx++) for (let dz = -5; dz <= 5; dz++) for (let dy = 1; dy >= -3; dy--) {
            const approach = origin.offset(dx,dy,dz);
            const range = approach.distanceTo(origin);
            if (range >= score || missedStoneEntrances.has(approach.toString()) || nearPlayer(approach)
                || !grounded(approach, woodTrail)) continue;
            const aim = approach.offset(0.5,0,0.5);
            const clearance = [origin.offset(0,2,0), approach.offset(0,2,0)];
            const jump = approach.y === origin.y + 1 && Math.abs(dx) + Math.abs(dz) === 1
                && bot.entity.onGround && overheadStable(origin) && overheadStable(approach)
                && dryNeighborhood(bot, approach) && clearance.every(cell => woodTrail(bot.blockAt(cell)));
            const direct = !approach.equals(origin) && directWalkSafe(aim);
            if (vineStalls >= 2 && range && !jump && !direct) continue;
            for (const [x,z] of offsets.slice(0,4)) {
                const entry = approach.offset(x,0,z);
                const end = landing(entry);
                if (!end) continue;
                const cost = range + (foliage(bot.blockAt(end.offset(0,-1,0))) ? 4 : 0);
                if (cost >= score) continue;
                best = { approach, entry, end, clearance, jump, direct };
                score = cost;
            }
        }
        if (!best) return false;
        const { approach, entry, end, clearance, jump, direct } = best;
        if (!approach.equals(origin)) {
            if (jump && jumpAscent(origin, approach, woodTrail, clearance, false)) return true;
            if (direct) {
                const action = begin('walk_to_vines', 'diamond', approach, 3000);
                if (directWalk(action, approach.offset(0.5,0,0.5), () => {
                    if (!groundCell().equals(approach))
                        missedStoneEntrances.set(approach.toString(), performance.now() + 45_000);
                    cancel();
                })) return true;
                cancel();
            }
            if (vineStalls >= 2) return false;
            begin('seek_vine_descent', 'diamond', approach, 8000);
            walkStaircase(bot, setWalking, new goals.GoalBlock(approach.x, approach.y, approach.z));
            bot.pathfinder.movements.allowParkour = false;
            return true;
        }
        const action = begin('descend_vines', 'diamond', end, 15_000);
        perform(action, async () => {
            const aim = entry.offset(0.5, eye(bot.entity).y - entry.y, 0.5);
            await bot.lookAt(aim, true);
            if (!actionValid(action) || !landing(entry)?.equals(end)) return;
            let advancing = true, entered = false;
            try {
                bot.setControlState('forward', true);
                for (let tick = 0; tick < 280 && actionValid(action); tick++) {
                    const cell = groundCell();
                    const onVine = cell.x === entry.x && cell.z === entry.z;
                    entered ||= onVine;
                    if (cell.equals(end) && grounded(end, woodTrail)) { diamond.blocked(); return; }
                    if (advancing && onVine && Math.hypot(pos().x - aim.x, pos().z - aim.z) < 0.24) {
                        advancing = false;
                        bot.setControlState('forward', false);
                    }
                    if ((!entered && tick >= 35) || (entered && (!onVine || bot.blockAt(cell)?.name !== 'vine'))
                        || nearPlayer(cell)) return;
                    await wait(50);
                }
            } finally {
                if (actionValid(action)) {
                    bot.setControlState('forward', false);
                    if (!groundCell().equals(end)) missedStoneEntrances.set(approach.toString(), performance.now() + 45_000);
                }
            }
        });
        return true;
    }
    function sameVineArea(point) {
        return vineStallCell?.y === point.y && vineStallCell.distanceTo(point) <= 2;
    }
    function vineRouteActive(now) {
        if (!['descend_vines', 'seek_vine_descent', 'jump_to_vines', 'walk_to_vines'].includes(job?.type)) return false;
        if (now < job.until && (job.type !== 'seek_vine_descent' || !stalled(job, now))) return true;
        if (job.type === 'seek_vine_descent') {
            missedStoneEntrances.set(job.target.toString(), now + 45_000);
            const cell = groundCell();
            if (!sameVineArea(cell)) {
                vineStalls = 0;
                vineStallCell = cell;
            }
            vineStalls++;
            if (vineStalls === 2) log(`Vine routes stalled twice at ${cell}; switching to direct approaches or another tree`);
        }
        cancel(1500);
        return true;
    }
    function descend(now, floor, branch) {
        for (const [key, until] of missedSteps) if (now >= until) missedSteps.delete(key);
        const cobble = inventory().find(item => cobbleMaterial.test(item.name));
        const origin = groundCell();
        const descending = origin.y > floor;
        const available = point => !missedSteps.has(point.toString()) && !nearPlayer(point);
        const detourAvailable = point => available(point) && !detourVisited.has(point.toString());
        if (!descending || detourY !== origin.y) {
            detour = undefined;
            detourY = origin.y;
            detourVisited.clear();
        }
        const nextDetourStep = () => {
            const delta = detour.target.minus(origin);
            const remaining = delta.dot(detour.direction);
            const point = origin.plus(detour.direction);
            if (remaining <= 0 || !origin.plus(detour.direction.scaled(remaining)).equals(detour.target)
                || !detourAvailable(point)) return;
            const candidate = detourColumn(bot, point);
            if (candidate && (!candidate.block || canMine(bot, candidate.block, inSight))) return { ...candidate, level: true };
        };
        let step;
        if (detour) {
            step = nextDetourStep();
            if (!step) detour = undefined;
        }
        if (!step && !descending && !branch) {
            for (const turn of [0,1,3]) {
                const heading = (ironHeading + turn) % 4;
                step = tunnelPlan(bot, floor, { heading }, inSight, available, Boolean(cobble), origin);
                if (!step) continue;
                if (turn) log(`Iron tunnel: turning from ${origin} toward ${step.point}`);
                ironHeading = heading;
                break;
            }
        } else {
            step ??= tunnelPlan(bot, floor, branch ? diamond.route() : null, inSight, available, Boolean(cobble), origin);
        }
        if (!step && descending) {
            detour = levelDetour(bot, origin, inSight, detourAvailable);
            if (detour) {
                log(`Dry staircase detour: ${detour.length} blocks from ${origin} toward ${detour.target}`);
                step = nextDetourStep();
            }
        }
        if (!step || nearPlayer(step.point)) {
            diamond.blocked('No visible, dry staircase or branch step on natural ground');
            return false;
        }
        diamond.blocked();
        if (step.scaffold) {
            const { reference, face, seal } = step.scaffold;
            const target = reference.position.plus(face);
            const action = begin('scaffold_mine', 'diamond', step.point, 4500);
            perform(action, async () => {
                await bot.equip(cobble, 'hand');
                const current = bot.blockAt(target);
                if (!actionValid(action) || nearPlayer(target) || (seal ? current?.name !== seal || !inSight(current)
                    : !air(current) || !dryNeighborhood(bot, target))
                    || bot.blockAt(reference.position)?.name !== reference.name
                    || seal && !inSight(bot.blockAt(reference.position))) return;
                try { await bot.placeBlock(reference, face); }
                finally {
                    if (actionValid(action) && bot.blockAt(target)?.name !== cobble.name)
                        missedSteps.set(step.point.toString(), performance.now() + 45_000);
                }
            });
            return true;
        }
        if (step.block) {
            const drops = diamonds.test(step.block.name) ? /^diamond$/ : descending && !step.level ? null
                : ironOre.test(step.block.name) ? /^raw_iron$/ : coalOre.test(step.block.name) ? /^coal$/ : null;
            if (mineProgress(step.block, drops)) {
                if (descending) job.stairTarget = step.point;
                return true;
            }
            missedSteps.set(step.point.toString(), now + 45_000);
            return true;
        }
        if (Object.values(bot.entities ?? {}).some(entity => entity.name === 'falling_block' && entity.isValid !== false
            && entity.position && Math.floor(entity.position.x) === step.point.x
            && Math.floor(entity.position.z) === step.point.z && entity.position.y >= step.point.y)) return true;
        if (descending) {
            const settled = cell => bot.entity.onGround || Math.abs(pos().y - cell.y) < 0.001
                || pos().y === cell.y - 0.125;
            if (!settled(origin)) return true;
            const action = begin(step.level ? 'step_detour' : 'step_down', 'diamond', step.point, 3500);
            const aim = step.point.offset(0.5, 0, 0.5);
            const open = () => {
                if (!step.level) return staircaseStepOpen(bot, step.point);
                const candidate = detourColumn(bot, step.point);
                return candidate && !candidate.block;
            };
            perform(action, async () => {
                let reached = false, advancing = true;
                try {
                    await bot.lookAt(aim.offset(0, eye(bot.entity).y - aim.y, 0), true);
                    if (!actionValid(action) || !open()) return;
                    bot.setControlState('forward', true);
                    for (let i = 0; i < 60 && actionValid(action); i++) {
                        if (!open() || nearPlayer(step.point)) return;
                        if (advancing && Math.abs(pos().x - aim.x) <= 0.17 && Math.abs(pos().z - aim.z) <= 0.17) {
                            advancing = false;
                            bot.setControlState('forward', false);
                        }
                        const cell = groundCell();
                        if (cell.equals(step.point) && settled(cell)) {
                            reached = true;
                            diamond.recordStair(origin, step.point);
                            recordTunnelStep(origin, step.point);
                            if (step.level) detourVisited.add(origin.toString());
                            else if (branch) diamond.advance(step.route);
                            if (step.point.y === -58) log('Diamond staircase reached Y=-58');
                            return;
                        }
                        if (cell.y < step.point.y || (!cell.equals(origin)
                            && !cell.offset(0,-1,0).equals(step.point) && !cell.equals(step.point))) return;
                        await wait(50);
                    }
                } finally {
                    if (actionValid(action) && !reached) {
                        missedSteps.set(step.point.toString(), performance.now() + 45_000);
                        log(`Staircase step failed toward ${step.point} from ${pos()}; rotating direction`);
                    }
                }
            });
            return true;
        }
        const action = begin('walk_mine', 'diamond', step.point, 8000);
        action.route = branch ? step.route : null;
        action.origin = origin;
        walkStaircase(bot, setWalking, new goals.GoalBlock(step.point.x, step.point.y, step.point.z));
        return true;
    }
    let nextSmelt = 0;
    function smeltFuel(items) {
        const coal = items.find(item => /^(coal|charcoal)$/.test(item.name));
        if (coal) return { item: coal, available: coal.count, capacity: 8 };
        const firstPick = !items.some(item => item.name === 'iron_pickaxe') && items.some(item => item.name === 'raw_iron');
        const sticks = items.filter(item => item.name === 'stick').reduce((n,item) => n + item.count, 0);
        const spare = firstPick ? (sticks >= 2 ? 0 : craftingWoodCost.stick) : reserveWood;
        const item = items.find(item => /_planks$/.test(item.name));
        const available = Math.min(item?.count ?? 0, woodUnits(items) - spare);
        if (available > 0) return { item, available, capacity: 1.5 };
    }
    function smelt(now, items, material) {
        if (now < nextSmelt) return false;
        const fuel = smeltFuel(items);
        const input = material ? items.find(i => i.name === material)
            : items.find(i => i.name === 'raw_iron') ?? items.find(i => rawFood[i.name]);
        const smeltPoint = diamond.smeltPoint();
        if (!smeltPoint && (!input || !fuel)) return false;
        const action = begin('smelt_goal', 'diamond', input?.name ?? 'furnace output', 8000);
        nextSmelt = now + 3000;
        perform(action, async () => {
            const block = smeltPoint ? localStation(smeltPoint, 'furnace') : await workstation('furnace', action);
            if (!block || !actionValid(action)) return;
            const window = await bot.openFurnace(block);
            try {
                if (!actionValid(action)) return;
                action.window = window;
                if (window.outputItem()) await window.takeOutput();
                if (!actionValid(action)) return;
                if (!window.inputItem() && input) {
                    const wanted = rawFood[input.name] ? 1 : input.count;
                    const queued = window.fuelItem();
                    const fuelCount = fuel && Math.min(fuel.available, Math.ceil(wanted / fuel.capacity));
                    if (!queued && fuelCount) await window.putFuel(fuel.item.type, null, fuelCount);
                    if (!actionValid(action)) return;
                    const loaded = window.fuelItem();
                    const capacity = loaded ? Math.floor(loaded.count * (/^(coal|charcoal)$/.test(loaded.name) ? 8 : 1.5))
                        : Number(window.fuelSeconds >= 10);
                    if (capacity) {
                        await window.putInput(input.type, null, Math.min(wanted, capacity));
                        diamond.blocked();
                    }
                }
                const output = window.outputItem()?.name;
                diamond.smelting(block.position, window.inputItem()?.name
                    ?? ({ iron_ingot: 'raw_iron', gold_ingot: 'raw_gold', netherite_scrap: 'ancient_debris' })[output]
                    ?? Object.keys(rawFood).find(name => rawFood[name] === output));
            } finally {
                if (actionValid(action) || !action.window) window.close();
                action.window = undefined;
            }
        });
        return true;
    }
    function equipArmor(state) {
        const items = inventory();
        const upgrades = Object.keys(diamondArmor).flatMap(slot => {
            if (slot === 'feet' && bot.game?.dimension === 'the_nether' && diamond.portal()
                && state.equippedArmor.feet === 'golden_boots' && state.netherite.upgraded < state.netherite.target) return [];
            const worn = armorRank(state.equippedArmor[slot], slot);
            const best = items.filter(item => armorRank(item.name, slot) > worn)
                .sort((a,b) => armorRank(b.name, slot) - armorRank(a.name, slot))[0];
            return best ? [[slot, best.name]] : [];
        });
        if (!upgrades.length) return false;
        const action = begin('equip_armor', 'diamond', undefined, 8000);
        perform(action, async () => {
            for (const [slot, name] of upgrades) {
                if (!actionValid(action) || urgent(threatList()).length) return;
                const item = inventory().find(item => item.name === name);
                if (item) await bot.equip(item, slot);
            }
        }, 500);
        return true;
    }
    function portalLayout(foot, axis) {
        const cell = (x, y) => axis === 'x' ? foot.offset(x,y,0) : foot.offset(0,y,x);
        const floor = [0,1,2,3].map(x => cell(x,0));
        const sides = [1,2,3,4].flatMap(y => [cell(0,y), cell(3,y)]);
        const frame = [...floor, ...sides, cell(1,4), cell(2,4)];
        const inside = [1,2,3].flatMap(y => [cell(1,y),cell(2,y)]);
        return { frame, inside, ignition: cell(1,0) };
    }
    function buildNetherPortal(now, base, obsidian) {
        if (typeof bot.placeBlock !== 'function' || typeof bot.activateBlock !== 'function' || !bot.entity.onGround) return false;
        const feet = groundCell();
        const saved = diamond.portal();
        const safeSite = layout => layout.inside.every(point => {
            const block = bot.blockAt(point);
            return (air(block) || block?.name === 'nether_portal') && !nearPlayer(point);
        }) && layout.frame.every(point => {
            const block = bot.blockAt(point);
            return (air(block) || block?.name === 'obsidian') && !nearPlayer(point);
        }) && layout.frame.slice(0,4).every(point => stableStationGround(point.offset(0,-1,0)));
        const planned = saved?.dimension === 'overworld' ? { foot: toVec(saved.foot), axis: saved.axis }
            : offsets.slice(0,4).map(([x,z]) => {
                const foot = feet.offset(2*x - Math.abs(z),0,2*z - Math.abs(x));
                return { foot, axis: x ? 'z' : 'x' };
            }).find(site => site.foot.distanceTo(base) <= 8 && safeSite(portalLayout(site.foot, site.axis)));
        if (!planned) return false;
        const layout = portalLayout(planned.foot, planned.axis);
        if (!safeSite(layout) || bot.blockAt(layout.inside[0])?.name === 'nether_portal') return false;
        const missing = layout.frame.filter(point => bot.blockAt(point)?.name !== 'obsidian');
        if (obsidian < missing.length) return false;
        const inReach = point => eye(bot.entity).distanceTo(point.offset(0.5,0.5,0.5)) < 4.5;
        const point = missing.find(point => stationClearance(point) && inReach(point) && stationReference(point));
        const target = point ?? (!missing.length && inReach(layout.ignition) && layout.ignition);
        if (!target) return false;
        if (!saved) diamond.setPortal({ foot: coords(planned.foot), axis: planned.axis, dimension: 'overworld',
            ...coords(layout.inside[0]) });
        const action = begin(point ? 'build_nether_portal' : 'light_nether_portal', 'diamond', target, 8000);
        perform(action, async () => {
            const material = inventory().find(item => item.name === (point ? 'obsidian' : 'flint_and_steel'));
            if (!material) return;
            await bot.equip(material, 'hand');
            if (!actionValid(action) || threatList().length || !safeSite(layout)) return;
            if (point) {
                const anchor = stationReference(point);
                if (anchor && air(bot.blockAt(point)) && stationClearance(point)) await bot.placeBlock(anchor.reference, anchor.face);
            } else {
                await bot.activateBlock(bot.blockAt(layout.ignition), new Vec3(0,1,0));
                for (let i = 0; i < 20 && actionValid(action); i++) {
                    if (bot.blockAt(layout.inside[0])?.name === 'nether_portal') {
                        log(`Nether portal lit at ${layout.inside[0]}`);
                        break;
                    }
                    await wait(50);
                }
            }
        }, 500);
        return true;
    }
    function enterNetherPortal(now) {
        const save = diamond.portal();
        const boots = inventory().find(item => item.name === 'golden_boots');
        if (!save || !boots || !bot.entity.onGround || !recoveryFood(bot) || threatList().length
            || typeof bot.lookAt !== 'function' || typeof bot.setControlState !== 'function') return false;
        const origin = groundCell();
        const { inside } = portalLayout(toVec(save.foot), save.axis);
        const lit = point => bot.blockAt(point)?.name === 'nether_portal';
        const groundEntry = point => lit(point) && lit(point.offset(0,1,0))
            && bot.blockAt(point.offset(0,-1,0))?.name === 'obsidian' && !nearPlayer(point);
        const entries = inside.filter(groundEntry);
        const target = entries.find(point => point.y === origin.y + 1
            && Math.abs(point.x - origin.x) + Math.abs(point.z - origin.z) === 1
            && air(bot.blockAt(origin.offset(0,2,0))));
        if (!target) {
            if (now < nextNetherEntry || !bot.pathfinder.movements) return false;
            const entry = entries.flatMap(point => stationSides(point.offset(0,-1,0)))
                .filter(point => spawnGround(point) && air(bot.blockAt(point.offset(0,2,0))))
                .sort((a,b) => a.distanceTo(origin) - b.distanceTo(origin))[0];
            if (!entry) return false;
            nextNetherEntry = now + 16_000;
            begin('approach_nether_portal', 'diamond', entry, 8000);
            walkStaircase(bot, setWalking, new goals.GoalBlock(entry.x, entry.y, entry.z));
            return true;
        }
        if (now < nextNetherJump) return false;
        nextNetherJump = now + 16_000;
        const action = begin('enter_nether_portal', 'diamond', target, 10_000);
        perform(action, async () => {
            const aim = target.offset(0.5,0,0.5);
            await bot.lookAt(aim.offset(0,eye(bot.entity).y - aim.y,0), true);
            if (!actionValid(action) || threatList().length) return;
            await bot.equip(boots, 'feet');
            if (!actionValid(action) || !groundEntry(target) || threatList().length || !groundCell().equals(origin)
                || bot.inventory?.slots?.[bot.getEquipmentDestSlot?.('feet')]?.name !== 'golden_boots') return;
            bot.setControlState('jump', true);
            bot.setControlState('forward', true);
            for (let i = 0; i < 30 && actionValid(action) && groundEntry(target); i++) {
                if (threatList().length) return;
                const cell = groundCell();
                if ((cell.x !== origin.x || cell.z !== origin.z) && (cell.x !== target.x || cell.z !== target.z)) return;
                if (pos().y >= target.y) bot.setControlState('jump', false);
                if (Math.hypot(pos().x - aim.x, pos().z - aim.z) <= 0.22) bot.setControlState('forward', false);
                if (cell.equals(target) && bot.entity.onGround) {
                    bot.clearControlStates();
                    for (let tick = 0; tick < 120 && actionValid(action) && !threatList().length
                        && bot.game?.dimension === 'overworld'; tick++) await wait(50);
                    return;
                }
                await wait(50);
            }
        });
        return true;
    }
    let nextNetherEntry = 0, nextNetherJump = 0;
    function prepareNether(now, state) {
        if (!state.netherite.unlocked || state.stage < 7 || state.netherite.complete) return false;
        const items = inventory();
        const count = name => items.filter(item => item.name === name).reduce((sum,item) => sum + item.count, 0);
        const visibleOre = (...names) => bot.findBlocks?.({ maxDistance: 8, count: 16, matching: block => names.includes(block.name) })
            .map(point => bot.blockAt(point)).find(block => block && !nearPlayer(block.position) && canMine(bot, block, inSight));
        if (diamond.smeltPoint()) return smelt(now, items);
        if (state.netherite.scrap >= 4 && count('gold_ingot') >= 4) return progressCraft('netherite_ingot');
        if (state.netherite.ancientDebris && smelt(now, items, 'ancient_debris')) return true;
        if (state.netherite.inNether)
            return mineProgress(visibleOre('ancient_debris'), /^ancient_debris$/);
        if (state.netherite.portalReady && enterNetherPortal(now)) return true;
        if (!state.netherite.goldArmor && count('gold_ingot') >= 4) return progressCraft('golden_boots');
        if (!state.netherite.flintAndSteel && count('iron_ingot') && count('flint')) return progressCraft('flint_and_steel');
        const base = diamond.spawnRelocation()?.base;
        if (base && groundCell().distanceTo(toVec(base)) <= 8 && !state.netherite.portalReady && state.netherite.flintAndSteel
            && buildNetherPortal(now, toVec(base), state.netherite.obsidian)) return true;
        if (!state.netherite.portalReady && state.netherite.obsidian < 14 && mineProgress(visibleOre('obsidian'), /^obsidian$/)) return true;
        if ((!state.netherite.goldArmor || state.netherite.scrap >= 4) && smelt(now, items, 'raw_gold')) return true;
        if (!state.netherite.goldArmor && mineProgress(visibleOre('gold_ore', 'deepslate_gold_ore'), /^raw_gold$/)) return true;
        if (!state.netherite.flintAndSteel && !count('iron_ingot') && smelt(now, items, 'raw_iron')) return true;
        if (!state.netherite.flintAndSteel && !count('iron_ingot')
            && mineProgress(visibleOre('iron_ore', 'deepslate_iron_ore'), /^raw_iron$/)) return true;
        if (!state.netherite.flintAndSteel && !count('flint') && mineProgress(visibleOre('gravel'), /^(?:flint|gravel)$/)) return true;
        if (bot.game?.dimension === 'overworld' && base && !nearSurface(groundCell(), true)
            && groundCell().y < base.y) {
            const target = toVec(base);
            return climbStep(now, target.offset(0,1,0), true);
        }
        if (base && groundCell().distanceTo(toVec(base)) > 8 && now >= nextNetherEntry && bot.pathfinder.movements) {
            nextNetherEntry = now + 16_000;
            const target = toVec(base);
            begin('return_to_portal_base', 'diamond', target, 12_000);
            walkStaircase(bot, setWalking, new goals.GoalNear(target.x, target.y, target.z, 3));
            return true;
        }
        return false;
    }
    function progress(now, state) {
        if (state.complete) return prepareNether(now, state);
        const items = inventory();
        const has = name => items.some(i => i.name === name);
        const count = name => items.filter(i => i.name === name).reduce((n,i) => n + i.count, 0);
        const { stationPoint, furnacePoint } = diamond.stations();
        const wood = woodUnits(items);
        const deepUnderway = Boolean(diamond.route());
        const tableSupply = () => {
            if (has('crafting_table') || localStation(diamond.stations().stationPoint, 'crafting_table')) return;
            const log = items.find(i => logName(i.name));
            return wood >= reserveWood + 4 ? 'crafting_table' : log?.name.replace(/_log$/, '_planks') ?? 'gather wood';
        };
        const travelReady = () => {
            if (!has('crafting_table') || !has('furnace')) {
                diamond.blocked('Need to pack the crafting table and furnace before descending');
                return false;
            }
            if (count('stick') < 2) {
                diamond.blocked('Need two sticks to keep mining');
                return false;
            }
            return true;
        };
        const travelSupplies = () => {
            if (!has('furnace')) return recoverWorkstation(furnacePoint, 'furnace', now)
                || (has('crafting_table') || localStation(stationPoint, 'crafting_table'))
                    && items.filter(item => cobbleMaterial.test(item.name)).reduce((n,item) => n + item.count, 0) >= 8
                    && progressCraft('furnace') || gear(now, []);
            if (!has('crafting_table')) {
                const supply = tableSupply();
                if (localStation(stationPoint, 'crafting_table') && recoverWorkstation(stationPoint, 'crafting_table', now)) return true;
                if (wood >= reserveWood + 4) return progressCraft('crafting_table');
                return recoverWorkstation(stationPoint, 'crafting_table', now) || (supply && supply !== 'gather wood'
                    ? progressCraft(supply) : gatherSpareWood(now, []));
            }
            if (count('stick') < 2 && wood >= 2) return progressCraft('stick', 0);
            return gatherSpareWood(now, []);
        };
        const stockSurfaceWood = (sticks = deepSticks) => {
            if (countLogs(items) < deepLogs) return gatherSpareWood(now, []);
            return count('stick') < sticks && progressCraft('stick', deepLogs * 4);
        };
        const stockForDeepDescent = () => {
            const sparePick = has('stone_pickaxe');
            if (stockSurfaceWood(deepSticks + (sparePick ? 0 : 2))) return true;
            const cobble = items.reduce((n,item) => n + (cobbleMaterial.test(item.name) ? item.count : 0), 0);
            if (cobble < deepCobble + (sparePick ? 0 : 3)) {
                gatherResource(now, items, true, { stockpiling: true });
                return true;
            }
            return !sparePick && progressCraft('stone_pickaxe');
        };
        const ore = pattern => bot.findBlocks({ maxDistance: 8, count: 16, matching: b => pattern.test(b.name) })
            .map(point => bot.blockAt(point)).find(b => b && !nearPlayer(b.position) && canMine(bot, b, inSight));
        const findIron = () => {
            if (!travelReady()) return travelSupplies();
            if (mineProgress(ore(ironOre), /^raw_iron$/)) return true;
            const searchY = deepUnderway ? -24 : ironSearchY;
            const cell = groundCell();
            if (cell.y > searchY && nearSurface(cell, true) && stockSurfaceWood()) return true;
            if (cell.y < searchY && climbStep(now, cell.offset(1024, searchY + 1 - cell.y, 0), true)) return true;
            return descend(now, searchY, false);
        };
        if (state.stage === 1) return false;
        if (state.stage === 2) {
            if (state.needs.includes('crafting table')) {
                return recoverWorkstation(stationPoint, 'crafting_table', now) || progressCraft('crafting_table', 0);
            }
            if (!state.wood) return gatherSpareWood(now, []);
            return false;
        }
        if (state.stage <= 5 && diamond.spawnRelocation()?.base && !savedBaseBedPending()
            && typeof bot.getEquipmentDestSlot === 'function' && typeof bot.equip === 'function' && !hasShield()) {
            if (has('iron_ingot')) return gatherSpareWood(now, []);
            if (has('raw_iron') || diamond.smeltPoint()) {
                if (!diamond.smeltPoint() && !smeltFuel(items))
                    return mineProgress(ore(coalOre), /^coal$/) || gatherSpareWood(now, []);
                return !has('furnace') && recoverWorkstation(furnacePoint, 'furnace', now) || smelt(now, items);
            }
            return findIron();
        }
        if (state.stage === 3) return findIron();
        if (state.stage === 4) {
            const armor = state.spareArmor;
            if (state.armorNeeded && !armor && !diamond.smeltPoint()) return findIron();
            const ready = state.ironPick ? armor && count('iron_ingot') >= ironArmor[armor] : count('iron_ingot') >= 3;
            if (ready && !diamond.smeltPoint()) {
                const furnace = localStation(furnacePoint, 'furnace');
                if (!has('furnace') && furnace && packWorkstation(furnace)) return true;
                const supply = tableSupply();
                if (supply === 'gather wood') {
                    return (!has('furnace') && packWorkstation(localStation(furnacePoint, 'furnace')))
                        || reachWorkstation(stationPoint, 'crafting_table', now) || gatherSpareWood(now, []);
                }
                return progressCraft(supply ?? (armor || (count('stick') < 2 ? 'stick' : 'iron_pickaxe')), deepUnderway ? 0 : reserveWood);
            }
            const furnace = localStation(diamond.stations().furnacePoint, 'furnace');
            if (!furnace && !has('furnace')) return recoverWorkstation(furnacePoint, 'furnace', now) || gear(now, []);
            if (!has('crafting_table') && packWorkstation(localStation(stationPoint, 'crafting_table'))) return true;
            if (!diamond.smeltPoint() && !smeltFuel(items))
                return mineProgress(ore(coalOre), /^coal$/) || gatherSpareWood(now, []);
            return smelt(now, items);
        }
        if (state.stage === 5) {
            if (!deepUnderway && !diamond.spawnRelocation()?.base && canSetBedSpawn() && !diamond.bed()?.spawnSet) {
                if (!job && !hasShield()) {
                    if (has('iron_ingot')) return gatherSpareWood(now, []);
                    if (diamond.smeltPoint() || has('raw_iron')) {
                        if (!diamond.smeltPoint() && !smeltFuel(items))
                            return mineProgress(ore(coalOre), /^coal$/) || gatherSpareWood(now, []);
                        return !has('furnace') && recoverWorkstation(furnacePoint, 'furnace', now) || smelt(now, items);
                    }
                    return findIron();
                }
                return false;
            }
            if (typeof bot.getEquipmentDestSlot === 'function'
                && (!/^(?:iron|diamond|netherite)_helmet$/.test(state.equippedArmor.head)
                    || !/^(?:iron|diamond|netherite)_chestplate$/.test(state.equippedArmor.torso))) {
                diamond.blocked('Equip an iron helmet and chestplate or better before diamond mining');
                return equipArmor(state);
            }
            if (!travelReady()) return travelSupplies();
            if ((!deepUnderway || nearSurface(groundCell(), true)) && stockForDeepDescent()) return true;
            return mineProgress(ore(diamonds), /^diamond$/) || descend(now, -58, true);
        }
        const sticksNeeded = 2 * Number(state.missingKit.includes('diamond_pickaxe'))
            + Number(state.missingKit.includes('diamond_sword'));
        if (count('stick') < sticksNeeded) return progressCraft('stick', 0);
        const item = state.missingKit[0];
        const supply = tableSupply();
        return supply === 'gather wood' ? gatherSpareWood(now, [])
            : progressCraft(supply ?? item);
    }
    function recover(item, now) {
        if (job || pending) cancel();
        const recovery = { type: 'eat', until: now + 5000 };
        job = recovery;
        change({ type: 'eat', item: item.name });
        void bot.equip(item, 'hand').then(async () => {
            if (job !== recovery || !canRun() || bot.food === 20) return;
            recovery.eating = true;
            await bot.consume();
            recovery.eating = false;
        }).catch(() => {}).finally(() => { if (job === recovery) cancel(2500); });
    }
    function recoverDeathDrops(now) {
        const site = diamond.deathSite();
        if (!site) return false;
        const point = toVec(site);
        const distance = pos().distanceTo(point);
        const finish = reason => {
            if (job?.kind === 'death_recovery') cancel();
            diamond.finishDeathRecovery();
            log(`Death recovery: ${reason}`);
            return false;
        };
        if (Date.now() - site.at >= deathRecoveryMs) return finish('recovery window expired');
        if (site.dimension !== bot.game?.dimension || distance > deathRecoveryRange || Math.abs(pos().y - point.y) > 48)
            return finish('death site too far from respawn');
        if (nearPlayer(point)) return finish('another player is near the drops');
        if (job?.kind === 'death_recovery') {
            if (job.type === 'collect_death_drops') {
                const drop = bot.entities?.[job.drop.id];
                if (!drop) cancel();
                else if (job.walkingDirect || job.digging || recoverPickup(job, drop, now)
                    || now - job.pickupSince < 5000) return true;
            }
            if (job?.type === 'return_to_death_site' && distance <= 4) cancel();
            else if (job?.type === 'scan_death_drops' && now >= job.until) return finish('no more dropped items visible at the death site');
            else if (job && (now >= job.until || stalled(job, now))) return finish('no safe walking path to the death drops');
            else if (job && job.type !== 'scan_death_drops') return true;
        }
        if (distance > 4 && job?.kind !== 'death_recovery') {
            begin('return_to_death_site', 'death_recovery', point, deathRecoveryMs - (Date.now() - site.at));
            walkStaircase(bot, setWalking, new goals.GoalNear(point.x, point.y, point.z, 3));
            return true;
        }
        const drop = bot.nearestEntity?.(entity => entity.position?.distanceTo(point) <= 6
            && !nearPlayer(entity.position) && entity.getDroppedItem?.()
            && (!workstationName.test(entity.getDroppedItem().name) || stationPickupGround(entity.position.floored())));
        if (drop) {
            const action = begin('collect_death_drops', 'death_recovery', drop.position.floored(), 6000);
            action.drop = drop;
            if (workstationName.test(drop.getDroppedItem().name)) {
                action.stationName = drop.getDroppedItem().name;
                const { x, y, z } = action.target;
                walkStaircase(bot, setWalking, new goals.GoalBlock(x, y, z));
            } else walk(action.target, 0);
        } else if (job?.type !== 'scan_death_drops') begin('scan_death_drops', 'death_recovery', point, 2000);
        return true;
    }
    function plan(forWood = false) {
        if (!worker) {
            worker = new Worker(path.join(__dirname, 'idle-planner.cjs'));
            worker.unref();
            worker.on('message', apply);
            worker.on('error', () => {
                pending = 0;
                worker = undefined;
                cancel(30_000);
            });
        }
        const pos = bot.entity.position;
        const origin = forWood ? groundCell() : pos.floored();
        const sites = [];
        let timber;
        let checkedTrunk = false;
        let nearest;
        let minimum = 16;
        for (const player of Object.values(bot.players)) {
            if (!player.entity || player.entity === bot.entity || player.username === bot.username) continue;
            const distance = player.entity.position.distanceTo(pos);
            if (distance < minimum) { nearest = player.username; minimum = distance; }
        }
        for (let i = 0; i < 16; i++) {
            const x = Math.floor(Math.random() * 17) - 8;
            const z = Math.floor(Math.random() * 17) - 8;
            const spot = origin.offset(x, 0, z);
            if ((!forWood && spot.distanceTo(home) > 20) || spot.distanceTo(origin) < 2) continue;
            for (const dy of [0, 1, -1]) {
                const base = spot.offset(0, dy, 0);
                if (grounded(base, forWood ? woodTrail : air)) sites.push(coords(base));
                if (!forWood && !checkedTrunk && performance.now() >= nextHarvest && logName(bot.blockAt(base)?.name)) {
                    checkedTrunk = true;
                    if (naturalTrunk(bot, base)) timber = { position: coords(base) };
                }
            }
        }
        if (!forWood && performance.now() >= nextHarvest && typeof bot.nearestEntity === 'function') {
            const drop = bot.nearestEntity(entity => entity.position.distanceTo(pos) <= 7 && logName(entity.getDroppedItem?.()?.name));
            if (drop) timber = { dropped: true, position: coords(drop.position.floored()) };
        }
        pending = ++requested;
        worker.postMessage({ id: pending, turn, sites, timber, nearby: forWood ? undefined : nearest });
    }
    function apply(intent) {
        if (intent.id !== pending) return;
        pending = 0;
        if (!eligible() || job || performance.now() < delayUntil) return;
        try {
            turn = intent.next;
            if (intent.type === 'idle') return;
            setWalking(bot);
            const target = intent.type === 'follow' ? bot.players[intent.target]?.entity : toVec(intent.target);
            if (!target) return;
            job = { ...intent, until: performance.now() + ends[intent.type], target };
            change({ type: intent.type, target: intent.target });
            if (intent.type === 'follow') bot.pathfinder.setGoal(new goals.GoalFollow(target, 3), true);
            else if (intent.type === 'gather') bot.pathfinder.setGoal(new goals.GoalNear(target.x, target.y, target.z, 3));
            else bot.pathfinder.setGoal(new goals.GoalBlock(target.x, target.y, target.z));
        } catch (error) {
            log(`Idle behavior skipped: ${error.name}`);
            cancel(10_000);
        }
    }
    function solidAt(sample) {
        const cell = sample.floored();
        const block = bot.blockAt?.(cell);
        if (block?.shapes) {
            const { x,y,z } = sample.minus(cell);
            return block.shapes.some(([x0,y0,z0,x1,y1,z1]) => x >= x0 && x < x1 && y >= y0 && y < y1 && z >= z0 && z < z1)
                ? block : undefined;
        }
        return block?.boundingBox === 'block' ? block : undefined;
    }
    function escapeSuffocation(fromDamage = false) {
        if (job?.type === 'escape_suffocation') {
            if (performance.now() < job.until) return true;
            cancel();
        }
        if (!fromDamage && !solidAt(eye(bot.entity))) return false;
        const origin = groundCell();
        const action = begin('escape_suffocation', 'emergency', origin, 10_000);
        bot.pathfinder.setGoal(null);
        bot.clearControlStates();
        perform(action, async () => {
            for (const obstruction of [() => solidAt(eye(bot.entity)), () => solidAt(pos().offset(0,0.05,0))]) {
                const block = obstruction();
                if (!actionValid(action)) return;
                if (!block || !bot.canDigBlock?.(block)) continue;
                action.digging = true;
                try { await bot.dig(block, 'ignore'); }
                finally { action.digging = false; }
            }
            const safeExit = point => grounded(point) && !nearPlayer(point) && overheadStable(point) && dryNeighborhood(bot, point);
            const exit = offsets.slice(0,4).map(([x,z]) => groundCell().offset(x,0,z)).find(safeExit);
            if (!exit || !actionValid(action) || !bot.lookAt || !bot.setControlState) return;
            await bot.lookAt(exit.offset(0.5, eye(bot.entity).y - exit.y, 0.5), true);
            if (!actionValid(action) || !safeExit(exit)) return;
            bot.setControlState('forward', true);
            for (let i = 0; i < 20 && actionValid(action) && safeExit(exit); i++) {
                if (Math.hypot(pos().x - exit.x - 0.5, pos().z - exit.z - 0.5) < 0.2) break;
                await wait(50);
            }
        });
        return true;
    }
    function tick() {
        const now = performance.now();
        const late = now - expected;
        expected = now + interval;
        if (canRun() && escapeSuffocation()) { lowerShield(); return; }
        if (late > 750) {
            lowerShield();
            cancel(30_000);
            lagUntil = now + 30_000;
            return;
        }
        if (!canRun()) { lowerShield(); if (job || pending || current.type !== 'idle') cancel(); return; }
        if (bot.isSleeping) return;
        const equipped = hasShield();
        if (equipped && !shieldEquipped) log('Shield equipped in offhand');
        shieldEquipped = equipped;
        if (!started) { started = now; home = bot.entity.position.floored(); }
        if (job?.type === 'hunt_sheep' && !sheepHuntSafe(bot, job.sheep)) cancel();
        if (now < lagUntil) return;
        if (job?.kind === 'forest') {
            const point = pos().clone();
            woodTrip.walked += job.lastPosition.distanceTo(point);
            job.lastPosition = point;
            if (woodTrip.walked >= forestLimit || point.distanceTo(toVec(woodTrip.origin)) >= forestLimit) {
                woodTrip.walked = forestLimit;
                cancel();
            }
        }
        const threats = threatList();
        const feet = pos().floored();
        const onGround = !foliage(bot.blockAt?.(feet.offset(0,-1,0))) || [2,3].some(y => ground.test(bot.blockAt?.(feet.offset(0,-y,0))?.name ?? ''));
        const safe = !urgent(threats).length && onGround;
        if (lastHealth === undefined || lastHealth > 10 || bot.health > lastHealth) healthChangedAt = now;
        lastHealth = bot.health;
        healthReady = bot.health > 10 || (bot.food >= 18 && now - healthChangedAt < 10_000);
        const state = diamond.snapshot({ safe, healthReady, station: Boolean(localStation(diamond.stations().stationPoint, 'crafting_table')),
            furnace: Boolean(localStation(diamond.stations().furnacePoint, 'furnace')) });
        earlySpawnStage = state.stage <= 2 && bot.game?.dimension === 'overworld';
        if (earlySpawnStage && !diamond.spawnRelocation())
            diamond.setSpawnRelocation({ origin: coords(feet) });
        const unarmored = Object.entries(state.equippedArmor).every(([slot, item]) => !armorRank(item, slot));
        const earlyThreats = unarmored || refuge?.early ? threatList(16) : threats;
        const bed = diamond.bed();
        const nearbyBaseBed = diamond.spawnRelocation()?.base && bed && !bed.spawnSet && !earlyThreats.length
            && bed.dimension === bot.game?.dimension && toVec(bed.stand).distanceTo(feet) <= 8
            && bedBlocks(bed).every(block => block?.name === bed.name);
        guard(earlyThreats);
        if (keepRefuge(earlyThreats, now)) return;
        const nearbyCreeper = urgent(threats).some(e => e.name === 'creeper' && canHit(e));
        if (job?.type === 'place_archer_cover' && now < job.until && !nearbyCreeper) return;
        if (prepareShield(now, false)) return;
        if (unarmored && !nearbyCreeper && !hasShield()) {
            const shooter = earlyThreats.find(e => archer.test(e.name) && lineClear(bot, eye(bot.entity), eye(e)));
            if (shooter && barricade(shooter, now)) return;
            if (earlyThreats.length && digRefuge(false, now, true)) return;
            if (!nearbyBaseBed && (dusk() || night()) && nearSurface(groundCell(), true) && digRefuge(true, now, true)) return;
        }
        if (handleThreat(threats, now)) return;
        if (job?.kind === 'threat') cancel();
        pillarAttempt = undefined;
        if (now < delayUntil) return;
        const atSavedBase = Boolean(diamond.spawnRelocation()?.base);
        if (atSavedBase && relocateSpawn(now, safe)) return;
        if (job?.type === 'eat') { if (now >= job.until) cancel(2500); return; }
        if (safe && (bot.health < 16 || atSavedBase && state.stage >= 3) && bot.food < 18) {
            const item = recoveryFood(bot);
            if (item && typeof bot.consume === 'function') { recover(item, now); return; }
            if (typeof bot.nearestEntity === 'function' && food.tick({ seek: true, roam: false })) return;
        }
        if (prepareBed(now, safe, false, true)) return;
        const bedBeforeIron = savedBaseBedPending();
        if (!bedBeforeIron && prepareShield(now, safe)) return;
        if (!nearbyBaseBed && night() && typeof bot.placeBlock === 'function' && nearSurface(groundCell(), true) && digRefuge(true, now)) return;
        if (sealTunnel() || !(earlySpawnStage && diamond.spawnRelocation()?.escape) && stockDefenseBlocks(now)) return;
        const tableRecovery = diamond.tableRecovery();
        const enoughForTable = woodUnits(inventory()) >= craftingWoodCost.crafting_table;
        const workshopReady = tableRecovery?.phase === 'rebuild' || tableRecovery?.phase === 'restock' && enoughForTable;
        const urgentFood = bot.food <= urgentHunger;
        if (bot.food <= 14 && !urgentFood && healthReady && safe && !job) {
            const item = recoveryFood(bot);
            if (item && typeof bot.consume === 'function') { recover(item, now); return; }
        }
        if (urgentFood || !healthReady) {
            const item = recoveryFood(bot);
            const shouldSurface = urgentFood && !item && !workshopReady && state.ironPick && typeof bot.canDigBlock === 'function'
                && (job?.foodAscent || now < foodAscentUntil || !nearSurface(groundCell(), true));
            if (bot.food < 20 && food.tick({ seek: !item, eatable: item, roam: urgentFood && !shouldSurface })) return;
            if (item && bot.food < 20) { recover(item, now); return; }
            if (shouldSurface && !job) {
                const cell = groundCell();
                if (climbStep(now, cell.offset(1024, 256, 0), true)) {
                    foodAscentUntil = 0;
                    job.foodAscent = true;
                    diamond.blocked('Returning to the surface to find food before descending');
                    return;
                }
            }
        } else if (safe && !job && (!atSavedBase || state.stage >= 3) && !diamond.deathSite()
            && typeof bot.nearestEntity === 'function' && typeof bot.attack === 'function') {
            if (food.tick({ seek: true, roam: false, opportunistic: true })) return;
        } else food.stop();
        if (!eligible()) {
            if (job || pending) cancel();
            if (urgentFood) diamond.blocked('Eat or hunt before continuing the staircase');
            change({ type: 'recover', reason: bot.food === 20 ? 'waiting_for_regeneration' : 'no_safe_food' });
            return;
        }
        if (!diamond.spawnRelocation()?.base && relocateSpawn(now, safe)) return;
        if (recoverDeathDrops(now)) return;
        if (safe && !job && typeof bot.equip === 'function' && typeof bot.getEquipmentDestSlot === 'function' && equipArmor(state)) return;
        if ((!atSavedBase || state.stage >= 3)
            && prepareBed(now, safe, atSavedBase ? bedBeforeIron : state.stage === 5 && !diamond.route())) return;
        if (job?.kind === 'forest') {
            if (job.type === 'hop_forest' || job.type === 'jump_up_step' || job.type === 'pillar_forest_escape') {
                if (now >= job.until) cancel();
            } else if (now >= job.until || stalled(job, now)) {
                const target = job.target;
                missedForest.set(target.toString(), now + 120_000);
                missedForestHeadings.set(job.direction, now + 12_000);
                cancel();
                nextForestRoute = now + 1000;
                if (++forestStalls >= 2) {
                    forestStalls = 0;
                    const exit = new Vec3(target.x, Math.max(target.y, groundCell().y + 2), target.z);
                    if (pillarForestEscape(exit, now)) return;
                    if (continueForestAscent(now, new Vec3(exit.x, Math.max(exit.y, groundCell().y + 4), exit.z))) {
                        log(`Forest search: taking a dry ascent toward ${exit} after repeated stalls`);
                    } else if (!forestStep(target, now)) failedForestEscapes++;
                }
            }
            return;
        }
        if (tableRecovery?.phase === 'attempt') {
            const { stationPoint } = diamond.stations();
            if (inventory().some(item => item.name === 'crafting_table') || localStation(stationPoint, 'crafting_table')) {
                diamond.setTableRecovery(null);
            } else if (Date.now() >= tableRecovery.expires) {
                cancel();
                diamond.station('crafting_table');
                diamond.setTableRecovery({ phase: 'restock' });
                fallbackAscent = false;
                missedAscent.clear();
                log('Old crafting table attempt expired; restocking for a replacement');
                return;
            }
        }
        if (job?.kind === 'diamond') {
            if (vineRouteActive(now)) return;
            if (workstationRoute.test(job.type) && !feet.equals(job.lastCell)) {
                job.lastCell = feet;
                job.until = now + 8500;
            }
            if (now >= job.until || stalled(job, now)) {
                if (job.type === 'seek_stone_entrance')
                    missedStoneEntrances.set(job.target.toString(), now + 45_000);
                if (job.stairTarget) missedSteps.set(job.stairTarget.toString(), now + 45_000);
                if (job.type === 'walk_mine') {
                    missedSteps.set(job.target.toString(), now + 45_000);
                    diamond.blocked(`No safe walking path to staircase cell ${job.target}`);
                }
                if (workstationRoute.test(job.type) || workstationStep.test(job.type)) {
                    fallbackAscent = true;
                    if (workstationStep.test(job.type)) missedAscent.set(job.target.toString(), now + 45_000);
                    diamond.blocked(`Ascent stalled at ${pos().floored()}; trying a different staircase step`);
                }
                cancel(1500);
            }
            return;
        }
        if (tableRecovery?.phase === 'restock') {
            if (job?.kind === 'gear' && gear(now, threats)) return;
            if (enoughForTable) {
                diamond.setTableRecovery({ phase: 'rebuild' });
                woodTrip = undefined;
                forestAscent = undefined;
                woodFailures = 0;
                diamond.blocked();
                log('Have enough wood for a replacement workbench');
            } else {
                gatherSpareWood(now, threats);
                if (job && now >= job.until) cancel();
                return;
            }
        }
        if (diamond.tableRecovery()?.phase === 'rebuild') {
            if (job?.kind === 'gear' && gear(now, threats)) return;
            if (rebuildTable(now, inventory(), state.ironPick)) return;
        }
        if (gear(now, threats)) return;
        if (bedBeforeIron && state.stage >= 3) return;
        if (!job && now < nextGear && state.stage === 2 && state.needs.includes('stone pickaxe')) return;
        if (!urgent(threats).length && typeof bot.recipesFor === 'function' && progress(now, state)) return;
        if (!job) { if (!pending) plan(); return; }
        if (job.walkingDirect || job.type === 'collect' && job.digging) return;
        const drop = job.type === 'collect' && bot.nearestEntity?.(entity =>
            entity.position.distanceTo(job.target) < 2 && logName(entity.getDroppedItem?.()?.name));
        if (drop && recoverPickup(job, drop, now)) return;
        const blocked = stalled(job, now);
        if (blocked && drop && (walkToGearDrop(job, drop, now) || now - job.pickupSince < 5000)) return;
        if (now >= job.until || blocked
            || (job.type === 'follow' && (!bot.entities[job.target.id] || job.target.position.distanceTo(home) > 22))) {
            cancel(2500);
            return;
        }
        if (job.type !== 'gather' || job.digging) return;
        const block = bot.blockAt(job.target);
        if (!block || !bot.canDigBlock(block) || !bot.canSeeBlock(block)) return;
        if (!naturalTrunk(bot, job.target)) { cancel(2500); return; }
        const gathering = job;
        job.digging = true;
        nextHarvest = now + 120_000;
        bot.pathfinder.setGoal(null);
        void bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true).then(async () => {
            if (job !== gathering || !eligible()) return;
            const targetBlock = bot.blockAt(gathering.target);
            if (targetBlock?.stateId !== block.stateId || !targetBlock || !bot.canDigBlock(targetBlock) || !bot.canSeeBlock(targetBlock) || !naturalTrunk(bot, gathering.target)) {
                cancel(2500);
                return;
            }
            await bot.dig(targetBlock, 'ignore');
            if (job !== gathering || !eligible()) return;
            const target = gathering.target;
            job = { type: 'collect', target, until: performance.now() + 6000 };
            change({ type: 'collect', target: coords(target) });
            bot.pathfinder.setGoal(new goals.GoalBlock(target.x, target.y, target.z));
        }).catch(() => { if (job === gathering) cancel(3000); });
    }
    const timer = setInterval(() => {
        try { tick(); } catch (error) { log(`Idle behavior skipped: ${error.name}`); cancel(15_000); }
    }, interval);
    timer.unref();
    function onGoal() {
        food.onGoal();
        if (job?.type === 'approach_nether_portal' || job?.type === 'return_to_portal_base') cancel();
        if (job?.type === 'seek_bed_site' || job?.type === 'return_to_bed') cancel();
        if (job?.type === 'seek_forest') { forestStalls = failedForestEscapes = 0; cancel(); }
        if (job?.type === 'seek_stone_entrance' || job?.type === 'seek_vine_descent') cancel();
        if (job?.type === 'seek_defense_dirt') cancel();
        if (job?.type === 'walk_mine') {
            if (groundCell().equals(job.target) && !job.origin.equals(job.target)) recordTunnelStep(job.origin, job.target);
            diamond.advance(job.route);
            cancel();
        }
        if (workstationRoute.test(job?.type) || workstationStep.test(job?.type)) {
            fallbackAscent = workstationStep.test(job.type);
            if (fallbackAscent && !groundCell().equals(job.target)) {
                missedAscent.set(job.target.toString(), performance.now() + 45_000);
                diamond.blocked(`Ascent stalled at ${groundCell()}; trying a different staircase step`);
            } else diamond.blocked();
            cancel();
        }
        if (job?.type === 'wander' || job?.type === 'collect') cancel(2500);
        if (job?.kind === 'gear' && job.type === 'collect_gear' && !job.material) cancel();
    }
    function onJoin(player) {
        const now = Date.now();
        const name = player?.username;
        if (!canRun() || !started || performance.now() - started < 10_000 || !/^[a-z0-9_]{1,16}$/i.test(name ?? '') || name === bot.username) return;
        if (now - greetings.last < 45_000 || now - (greetings.players.get(name.toLowerCase()) ?? 0) < 10 * 60_000) return;
        for (const [key, at] of greetings.players) if (now - at >= 10 * 60_000) greetings.players.delete(key);
        greetings.last = now;
        greetings.players.set(name.toLowerCase(), now);
        bot.chat(`Hi, ${name}! Welcome to Pokecraft.`);
    }
    bot.on('goal_reached', onGoal);
    function onCombatPath(result) {
        if (job?.type !== 'fight' || job.swinging || job.waitUntil) return;
        job.pathStatus = result.status;
        job.pathFailed = result.status === 'noPath' || result.status === 'timeout';
    }
    bot.on('path_update', onCombatPath);
    function onCombatReset(reason) {
        if (job?.type === 'fight' && !job.swinging && !job.waitUntil) job.pathReset = reason;
    }
    bot.on('path_reset', onCombatReset);
    bot.on('playerJoined', onJoin);
    function onHurt(entity, source) {
        if (entity !== bot.entity) return;
        const recent = bot.pi_recentDamage;
        const type = recent && Date.now() - recent.at < 1500 ? recent.type : null;
        log(`Damage observed: ${type ?? 'unknown'}${source?.name ? ' from ' + source.name : ''}`);
        if (canRun() && /^(?:minecraft:)?(?:in_wall|suffocation)$/.test(type ?? '')) escapeSuffocation(true);
    }
    bot.on('entityHurt', onHurt);
    const onSpawnReset = () => {
        const record = diamond.bed();
        if (record?.spawnSet) diamond.setBed({ ...record, spawnSet: false });
    };
    bot.on('spawnReset', onSpawnReset);
    const onDeath = () => {
        const spawn = diamond.spawnRelocation();
        const death = diamond.deathSite();
        if (spawn?.base) diamond.setSpawnRelocation({ ...spawn, escape: {}, exhausted: false });
        else if (earlySpawnStage && spawn && death && death.dimension === 'overworld'
            && horizontal(spawn.origin, death) <= spawnRadius)
            diamond.setSpawnRelocation({ ...spawn,
                deaths: [...(spawn.deaths ?? []).filter(at => death.at - at <= spawnDeathWindow).slice(-1), death.at] });
        lowerShield();
        shieldEquipped = false;
        nextShieldCraft = 0;
        refuge = pillarAttempt = tunnelSeal = deferredPursuit = undefined;
        tunnelSteps = nextShelter = nextBarricade = nextSwing = fleeUntil = resumeUntil = 0;
        ironHeading = 0;
        forestStalls = failedForestEscapes = nextEscapePillar = nextRestockPillar = 0;
        vineStalls = 0;
        vineStallCell = lastStalledTree = undefined;
        spawnWaypoints = [];
        spawnCanopyRoute = [];
        nextSpawnStep = 0;
        missedSpawnSteps.clear();
        nextBedAttempt = nextBedHit = 0;
        missedSheep.clear();
        restockPillarActive = false;
        forestAscent = undefined;
        cancel();
    };
    bot.on('death', onDeath);
    return {
        status: () => current,
        cancel(pause) { lowerShield(); cancel(pause); },
        close() {
            detached = true;
            clearInterval(timer);
            clearInterval(statusTimer);
            bot.off('goal_reached', onGoal);
            bot.off('path_update', onCombatPath);
            bot.off('path_reset', onCombatReset);
            bot.off('playerJoined', onJoin);
            bot.off('entityHurt', onHurt);
            bot.off('spawnReset', onSpawnReset);
            bot.off('death', onDeath);
            diamond.close();
            lowerShield();
            cancel();
            if (worker) void worker.terminate();
        },
    };
}

module.exports = { attachIdle, gearPlan, naturalTrunk, recoveryFood, threatMode, walkStaircase };
