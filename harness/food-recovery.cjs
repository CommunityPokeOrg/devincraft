const { goals } = require('mineflayer-pathfinder');

const passive = new Set(['cow', 'pig', 'sheep', 'chicken']);
const sheepHuntThreat = /^(?:skeleton|bogged)$/;
const sheepHuntSafe = (bot, sheep) => bot.time?.timeOfDay >= 0 && bot.time.timeOfDay < 12000
    && bot.time.isDay !== false && !(bot.isRaining && bot.thunderState > 0)
    && !Object.values(bot.entities ?? {}).some(entity => sheepHuntThreat.test(entity.name)
        && entity.isValid !== false && entity.position?.distanceTo(sheep.position) <= 24);
const rawMeats = new Map([['beef', 'cooked_beef'], ['porkchop', 'cooked_porkchop'], ['mutton', 'cooked_mutton'], ['chicken', 'cooked_chicken']]);
const air = block => /^(air|cave_air|void_air)$/.test(block?.name ?? '');
const dangerous = name => /(?:water|lava|fire|magma|cactus|berry_bush|powder_snow|portal)/.test(name ?? '');
const naturalGround = /^(?:grass_block|dirt|coarse_dirt|podzol|mud|stone|sand|gravel|clay|moss_block|muddy_mangrove_roots)$/;
const attackDamage = { wooden: [4, 7], golden: [4, 7], stone: [5, 9], iron: [6, 9], diamond: [7, 9], netherite: [8, 10] };
const safeFood = (bot, name) => Boolean(bot.registry?.foodsByName?.[name])
    && !/^(?:rotten_flesh|spider_eye|poisonous_potato|pufferfish|chorus_fruit|suspicious_stew|chicken)$/.test(name);

function bestWeapon(items) {
    const score = item => {
        if (item.name === 'mace') return 6;
        if (item.name === 'trident') return 9;
        const match = /^(wooden|golden|stone|iron|diamond|netherite)_(sword|axe)$/.exec(item.name);
        return match ? attackDamage[match[1]][Number(match[2] === 'axe')] : 0;
    };
    return items.filter(item => score(item) > 0).sort((a, b) => score(b) - score(a) || Number(b.name.endsWith('_sword')) - Number(a.name.endsWith('_sword')))[0];
}

function openLand(bot, point) {
    const floor = bot.blockAt(point.offset(0, -1, 0));
    return floor?.boundingBox === 'block' && !dangerous(floor.name)
        && air(bot.blockAt(point)) && air(bot.blockAt(point.offset(0, 1, 0)));
}

function createFoodRecovery(bot, { setWalking, change, isActive, beforeTask = () => {}, onSearchStall = () => {}, placed = () => {},
    clearPickup = () => false, canBurnWood = () => true, now = Date.now, random = Math.random }) {
    let task, home, nextScan = 0, nextCook = 0, nextSwing = 0, nextSearch = 0, cooking, ownFurnace;
    let berrySearch = 0;
    const avoided = new Map();
    const recentGround = [];
    const items = () => bot.inventory.items();
    const item = name => items().find(candidate => candidate.name === name);
    const pos = () => bot.entity.position;
    const closeToPlayer = point => Object.values(bot.players ?? {}).some(p => p.entity !== bot.entity && p.entity?.position.distanceTo(point) < 10);
    const hostile = point => bot.nearestEntity(e => e.type === 'hostile' && e.position.distanceTo(point) < 9);
    const safe = point => !hostile(point) && !dangerous(bot.blockAt(point)?.name);
    const nearest = predicate => bot.nearestEntity(e => e !== bot.entity && e.isValid !== false && e.position.distanceTo(pos()) <= 18
        && home.distanceTo(e.position) <= 32 && (avoided.get(e.id) ?? 0) <= now() && predicate(e));
    const fuel = () => items().find(i => /^(?:coal|charcoal)$/.test(i.name))
        ?? items().find(i => /_(?:planks|log)$/.test(i.name) && canBurnWood(i));
    const nearbyBlock = name => bot.findBlock({ matching: block => block?.name === name, maxDistance: 4 });
    const furnaceMaterials = () => items().filter(i => /^(?:cobblestone|blackstone|cobbled_deepslate)$/.test(i.name))
        .reduce((sum, i) => sum + i.count, 0) >= 8;
    const cookAvailable = () => fuel() && !closeToPlayer(pos()) && (nearbyBlock('furnace') || item('furnace') || furnaceMaterials());
    const reachable = point => pos().distanceTo(point.offset(0.5, 0.5, 0.5)) < 4;
    const eligibleAnimal = e => passive.has(e.name) && e.metadata?.[16] !== true
        && e.metadata?.[2] == null && !closeToPlayer(e.position)
        && (e.name !== 'sheep' || sheepHuntSafe(bot, e))
        && (e.name !== 'chicken' || cookAvailable()) && safe(e.position)
        && ![[-1,0],[1,0],[0,-1],[0,1]].some(([x,z]) =>
            /(?:fence|wall)$/.test(bot.blockAt(e.position.floored().offset(x, 0, z))?.name ?? ''));

    function stop() {
        if (!task) return;
        const previous = task;
        task = undefined;
        previous.window?.close();
        if (previous.digging) bot.stopDigging?.();
        bot.pathfinder.setGoal(null);
        bot.clearControlStates();
    }
    function begin(type, target, limit, goal, dynamic = false) {
        stop();
        beforeTask();
        task = { type, target, until: now() + limit };
        change({ type, target: typeof target?.x === 'number' ? { x: target.x, y: target.y, z: target.z } : target });
        if (goal) {
            setWalking(bot, home);
            bot.pathfinder.setGoal(goal, dynamic);
        }
        return task;
    }
    function near(type, point, range) {
        return begin(type, point, 10_000, new goals.GoalNear(point.x, point.y, point.z, range));
    }
    function valid(run) { return isActive() && task === run; }

    async function place(run, name) {
        const material = item(name);
        if (!material) return;
        const origin = pos().floored();
        for (const [x, z] of [[1,0],[-1,0],[0,1],[0,-1],[2,0],[0,2]]) {
            const spot = origin.offset(x, 0, z);
            const floor = bot.blockAt(spot.offset(0, -1, 0));
            if (!openLand(bot, spot) || !naturalGround.test(floor.name) || closeToPlayer(spot) || !safe(spot)) continue;
            await bot.equip(material, 'hand');
            if (!valid(run) || !openLand(bot, spot)) return;
            await bot.placeBlock(floor, origin.offset(0, 1, 0).minus(origin));
            placed(name, spot);
            return bot.blockAt(spot);
        }
    }

    async function cook(run, raw) {
        let block = cooking ? bot.blockAt(cooking.point) : ownFurnace && bot.blockAt(ownFurnace);
        if (!cooking && (!block || block.name !== 'furnace' || !reachable(block.position))) block = nearbyBlock('furnace');
        if (!cooking && !block) {
            if (!item('furnace')) {
                let table = nearbyBlock('crafting_table');
                if (!table) table = await place(run, 'crafting_table');
                if (!table || !valid(run)) return;
                const recipe = bot.recipesFor(bot.registry.itemsByName.furnace.id, null, 1, table)[0];
                if (!recipe) return;
                await bot.craft(recipe, 1, table);
            }
            if (!valid(run)) return;
            block = await place(run, 'furnace');
            if (block?.name === 'furnace') ownFurnace = block.position;
        }
        if (!block || !reachable(block.position) || closeToPlayer(block.position) || !valid(run)) return;
        const furnace = await bot.openFurnace(block);
        try {
            if (!valid(run)) return;
            run.window = furnace;
            if (cooking) {
                if (furnace.outputItem()?.name === cooking.output && !furnace.inputItem()) {
                    await furnace.takeOutput();
                    cooking = undefined;
                }
                return;
            }
            if (furnace.inputItem() || furnace.fuelItem() || furnace.outputItem()) return;
            const burn = fuel();
            if (!burn || !raw) return;
            await furnace.putFuel(burn.type, null, 1);
            if (!valid(run)) return;
            await furnace.putInput(raw.type, null, 1);
            cooking = { point: block.position, output: rawMeats.get(raw.name), ready: now() + 11_000, until: now() + 30_000 };
        } finally {
            if (task === run || !run.window) furnace.close();
            run.window = undefined;
        }
    }

    function shouldCook() {
        if (cooking && now() >= cooking.until) cooking = undefined;
        if (cooking) {
            if (task?.type === 'cook') return true;
            if (now() < cooking.ready) return true;
        }
        if (task?.type === 'cook') return true;
        if (now() < nextCook || hostile(pos()) || closeToPlayer(pos())) return false;
        const raw = items().find(i => rawMeats.has(i.name));
        if (!cooking && (!raw || !cookAvailable())) return false;
        const run = begin('cook', cooking?.point ?? raw.name, 8000);
        nextCook = now() + (cooking ? 2000 : 35_000);
        void cook(run, raw).catch(() => {}).finally(() => {
            if (task === run) {
                if (cooking) nextCook = Math.max(now() + 2000, cooking.ready);
                stop();
            }
        });
        return true;
    }

    function search() {
        if (now() < nextSearch || hostile(pos())) return false;
        nextSearch = now() + 2500;
        const origin = pos().floored();
        let best, bestScore = -Infinity;
        for (let i = 0; i < 24; i++) {
            const angle = random() * Math.PI * 2;
            const range = 4 + random() * 5;
            const spot = origin.offset(Math.round(Math.cos(angle) * range), 0, Math.round(Math.sin(angle) * range));
            for (const dy of [0, 1, -1, 2, -2]) {
                const point = spot.offset(0, dy, 0);
                if (point.distanceTo(home) > 28 || !openLand(bot, point) || !safe(point)) continue;
                const score = (recentGround.length ? Math.min(...recentGround.map(p => p.distanceTo(point))) : point.distanceTo(origin)) - Math.abs(dy);
                if (score > bestScore) { best = point; bestScore = score; }
            }
        }
        if (!best) return false;
        recentGround.push(best);
        if (recentGround.length > 12) recentGround.shift();
        near('seek_food', best, 0).motion = { position: pos().clone(), since: now() };
        return true;
    }

    function tick({ seek, eatable, roam = true, opportunistic = false }) {
        if (!home || !task && !roam) home = pos().floored();
        if (task?.type === 'seek_food') {
            if (task.motion.position.distanceTo(pos()) >= 0.35) task.motion = { position: pos().clone(), since: now() };
            else if (now() - task.motion.since >= 3000) {
                onSearchStall(task.target);
                stop();
                return false;
            }
        }
        if (task && now() >= task.until) {
            if (task.entity) avoided.set(task.entity.id, now() + 25_000);
            stop();
        }
        for (const [id, until] of avoided) if (now() >= until) avoided.delete(id);
        if (eatable && !rawMeats.has(eatable.name)) { stop(); return false; }
        if (hostile(pos())) { stop(); return false; }
        if (!opportunistic && shouldCook()) return true;
        if (eatable || !seek) { stop(); return false; }
        if (task?.type === 'hunt') {
            const run = task, target = run.entity;
            if (!bot.entities[target.id] || target.isValid === false || !eligibleAnimal(target) || target.position.distanceTo(home) > 30
                || (opportunistic && target.position.distanceTo(pos()) > 2.9)) {
                stop();
                nextScan = 0;
            } else if (!run.swinging && now() >= nextSwing && target.position.distanceTo(pos()) <= 2.9) {
                const aim = target.position.offset(0, (target.height ?? 1) * 0.65, 0);
                const eye = pos().offset(0, bot.entity.eyeHeight ?? 1.62, 0);
                const delta = aim.minus(eye);
                const distance = delta.norm();
                if (distance && !bot.world.raycast(eye, delta.normalize(), distance)) {
                    nextSwing = now() + 1300;
                    run.swinging = true;
                    const weapon = bestWeapon(items());
                    void (async () => {
                        if (weapon && bot.heldItem?.name !== weapon.name) await bot.equip(weapon, 'hand');
                        if (!valid(run) || !eligibleAnimal(target)) return;
                        await bot.lookAt(aim, true);
                        if (valid(run) && bot.entities[target.id] && target.position.distanceTo(pos()) <= 2.9
                            && (target.name !== 'sheep' || sheepHuntSafe(bot, target))) bot.attack(target);
                    })().catch(() => {}).finally(() => { run.swinging = false; });
                }
            }
            if (task) return true;
        }
        if (task?.type === 'harvest_food') {
            const run = task;
            const block = bot.blockAt(run.target);
            if (!block || block.name !== 'sweet_berry_bush' || Number(block.getProperties().age) !== 3 || !safe(block.position.offset(0, 1, 0)) || closeToPlayer(block.position)) stop();
            else if (!run.picking && reachable(block.position) && bot.canSeeBlock(block)) {
                run.picking = true;
                const held = bot.heldItem;
                void (async () => {
                    if (held) await bot.unequip('hand');
                    if (valid(run)) await bot.activateBlock(block);
                })().catch(() => {}).finally(() => {
                    if (task === run) { stop(); nextScan = 0; berrySearch = now() + 2000; }
                });
            }
            if (task) return true;
        }
        if (task?.type === 'collect_food') {
            const run = task;
            const drop = bot.entities[run.entity.id];
            if (!drop) stop();
            else if (now() >= run.pickupAt && !run.pickupRecovery && clearPickup(run, drop, () => valid(run)))
                run.pickupRecovery = true;
        }
        if (!roam && task?.type === 'seek_food') stop();
        if (now() < nextScan) return Boolean(task);
        nextScan = now() + 2000;
        if (task && task.type !== 'seek_food') return true;
        const drop = nearest(e => {
            const name = e.getDroppedItem?.()?.name;
            return (!opportunistic || e.position.distanceTo(pos()) <= 3)
                && (safeFood(bot, name) || (name === 'chicken' && cookAvailable())) && !closeToPlayer(e.position) && safe(e.position);
        });
        if (drop) {
            const point = drop.position.floored();
            const run = near('collect_food', point, 0);
            run.entity = drop;
            run.pickupAt = now() + 5000;
            return true;
        }
        const berry = !opportunistic && now() >= berrySearch && bot.findBlock?.({
            maxDistance: 12,
            matching: b => b?.name === 'sweet_berry_bush' && Number(b.getProperties().age) === 3,
            useExtraInfo: b => !closeToPlayer(b.position) && safe(b.position.offset(0, 1, 0)),
        });
        if (berry) { near('harvest_food', berry.position, 2); return true; }
        const animal = nearest(e => eligibleAnimal(e) && (!opportunistic || e.position.distanceTo(pos()) <= 2.9));
        if (animal) {
            begin('hunt', animal.name, opportunistic ? 4500 : 18_000,
                opportunistic ? null : new goals.GoalFollow(animal, 2), true).entity = animal;
            return true;
        }
        return Boolean(task) || roam && search();
    }

    function onGoal() { if (task?.type === 'seek_food') stop(); }
    return { tick, stop, onGoal };
}

module.exports = { bestWeapon, createFoodRecovery, safeFood, sheepHuntSafe };
