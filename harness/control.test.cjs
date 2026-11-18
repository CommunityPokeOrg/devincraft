const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const { mkdtemp, readFile, rm, stat } = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');
const Vec3 = require('vec3');
const UUID = require('uuid-1345');
const createRegistry = require('prismarine-registry');
const createBlock = require('prismarine-block');
const { createSerializer, states } = require('minecraft-protocol');
const { Movements, goals } = require('mineflayer-pathfinder');
const { call } = require('./client.cjs');
const { startControl } = require('./control.cjs');
const { acknowledgeResourcePack, normalizeLegacyPackWrites } = require('./resource-pack.cjs');
const { attachPlayerChat, createInbox } = require('./player-chat.cjs');
const { retryDelayMs } = require('./reconnect.cjs');
const { choose } = require('./idle-planner.cjs');
const { attachIdle, gearPlan, naturalTrunk, recoveryFood, threatMode, walkStaircase } = require('./idle-behavior.cjs');
const { createFoodRecovery, safeFood } = require('./food-recovery.cjs');
const { assess, attachDiamond, canMine, diamondKit, tunnelPlan } = require('./diamond-goal.cjs');
const { createStatusTicker } = require('./status-loop.cjs');

test('private socket handles readiness, gameplay controls, and reconnect state', async t => {
    const socket = path.join(__dirname, `t-${process.pid}.sock`);
    let bot;
    const server = startControl({ getBot: () => bot, path: socket });
    t.after(() => new Promise(resolve => server.close(resolve)));
    await once(server, 'listening');
    const run = (command, ...args) => call(command, args, socket);
    assert.deepEqual(await run('status'), { state: 'waiting_for_microsoft' });
    await assert.rejects(run('stop'), /not ready/);

    const item = { name: 'stone', count: 6, slot: 2 };
    const entity = { id: 3, position: new Vec3(0, 64, 0) };
    const player = { id: 4, position: new Vec3(1, 64, 1), username: 'neighbor' };
    const block = { name: 'grass_block', position: new Vec3(0, 63, 0) };
    const effects = [];
    const effect = name => (...args) => effects.push([name, ...args]);
    bot = Object.assign(new EventEmitter(), {
        username: 'devincraftbot', version: '1.21.1', registry: createRegistry('1.21.1'),
        game: { gameMode: 'survival', dimension: 'overworld' }, entity, entities: { 3: entity, 4: player },
        world: { getColumn: () => assert.fail('Status must not stream chunks') },
        health: 18, food: 20, inventory: { items: () => [item] }, heldItem: item,
        players: { neighbor: { username: 'neighbor', entity: player } },
        pathfinder: { setMovements: effect('movements'), setGoal: effect('goal') },
        pvp: { stop: effect('pvp.stop') }, stopDigging: effect('stopDigging'), clearControlStates: effect('clear'),
        setControlState: effect('motion'),
        chat: effect('say'), look: effect('look'), attack: effect('attack'), equip: effect('equip'),
        blockAt: () => block, canDigBlock: candidate => candidate === block, dig: effect('dig'), placeBlock: effect('place'),
    });
    const status = await run('status');
    assert.equal(status.state, 'spawned');
    assert.equal(status.dimension, 'overworld');
    const goal = await run('goal');
    assert.equal(goal.stage, 2);
    assert.equal(goal.diamonds.needed, 29);
    assert.deepEqual(status.position, { x: 0, y: 64, z: 0 });
    assert.deepEqual(status.inventory, [item]);
    assert.equal(status.health, 18);
    assert.deepEqual(status.autonomous, { enabled: false, behavior: { type: 'idle' } });
    assert.deepEqual(await run('auto', 'on'), { enabled: true });
    assert.equal((await run('status')).autonomous.enabled, true);
    assert.deepEqual(await run('auto', 'off'), { enabled: false });
    await assert.rejects(run('auto', 'maybe'), /auto on or auto off/);
    assert.deepEqual(await run('statusloop', 'off'), { enabled: false });
    await assert.rejects(run('statusloop', 'maybe'), /statusloop on or statusloop off/);
    assert.equal(status.food, 20);
    assert.deepEqual(status.players, ['neighbor']);
    assert.deepEqual(status.nearbyEntities.map(entity => entity.id), [4]);
    bot.emit('messagestr', 'hello from neighbor', 'chat');
    assert.equal((await run('chat', '1'))[0].message, 'hello from neighbor');
    await assert.rejects(run('say', ' /op neighbor'), /non-command/);
    assert.deepEqual(await run('say', 'Hello, neighbor.'), { sent: true });
    await assert.rejects(run('goto', '0.2', '64', '0'), /integer/);
    assert.deepEqual(await run('goto', '2', '64', '3'), { type: 'goto', x: 2, y: 64, z: 3 });
    assert.equal(effects.find(([name]) => name === 'movements')[1].canDig, false);
    bot.emit('goal_reached');
    assert.equal((await run('status')).action, null);
    assert.deepEqual(await run('follow', 'neighbor'), { type: 'follow', player: 'neighbor' });
    const paths = ['idle-behavior', 'idle-planner', 'food-recovery', 'scene', 'player-chat', 'control-actions']
        .map(name => require.resolve(`./${name}.cjs`));
    const cached = paths.map(file => require.cache[file]);
    const listeners = bot.eventNames().map(event => [event, bot.listenerCount(event)]);
    const moves = effects.length;
    await assert.rejects(run('reload', 'extra'), /Wrong argument count/);
    assert.deepEqual(await run('reload'), { reloaded: true, state: 'spawned' });
    for (const [index, file] of paths.entries()) assert.notEqual(require.cache[file], cached[index]);
    assert.deepEqual(bot.eventNames().map(event => [event, bot.listenerCount(event)]), listeners);
    assert.equal(effects.length, moves);
    const updated = await run('status');
    assert.deepEqual(updated.action, { type: 'follow', player: 'neighbor' });
    assert.equal(updated.autonomous.enabled, false);
    assert.deepEqual(await run('statusloop', 'on'), { enabled: true });
    assert.equal((await run('chat', '1'))[0].message, 'hello from neighbor');
    assert.deepEqual(await run('look', '180', '-45'), { yaw: 180, pitch: -45 });
    assert.deepEqual(await run('dig', '0', '63', '0'), { dug: 'grass_block' });
    assert.deepEqual(effects.find(([name]) => name === 'dig'), ['dig', block, true]);
    assert.deepEqual(await run('place', '0', '63', '0', 'east'), { placed: { x: 1, y: 63, z: 0 } });
    assert.deepEqual(await run('equip', 'stone'), { equipped: 'stone' });
    assert.deepEqual(await run('attack', '4'), { attacked: 4 });
    await assert.rejects(run('attack', '3'), /within melee reach/);
    assert.deepEqual(await run('stop'), { stopped: true });
    assert.deepEqual(effects.filter(([name]) => ['say', 'look', 'equip', 'attack'].includes(name)), [
        ['say', 'Hello, neighbor.'], ['look', Math.PI, -Math.PI / 4, true], ['equip', item, 'hand'], ['attack', player],
    ]);
    assert.deepEqual(effects.slice(-4), [['pvp.stop'], ['goal', null], ['stopDigging'], ['clear']]);
    assert.deepEqual(await run('step', 'north', 'jump'), { position: { x: 0, y: 64, z: 0 } });
    assert.deepEqual(effects.slice(-5), [['goal', null], ['look', 0, 0, true], ['motion', 'forward', true], ['motion', 'jump', true], ['clear']]);
    await assert.rejects(run('pillar', '9'), /integer/);
    await assert.rejects(run('pillar', '1'), /Not enough scaffold blocks/);
    const previousBlockAt = bot.blockAt;
    const placements = new Set();
    entity.position = new Vec3(0.5,64,0.5);
    entity.onGround = true;
    bot.blockAt = position => {
        const name = position.y < 64 ? 'stone' : placements.has(position.y) ? 'dirt' : 'air';
        return { name, position, boundingBox: name === 'air' ? 'empty' : 'block' };
    };
    bot.inventory.items = () => [{ name: 'dirt', count: 2 }, { name: 'dirt', count: 1 }];
    bot.setControlState = (control, enabled) => {
        if (control !== 'jump' || !enabled) return;
        assert.ok(entity.onGround);
        entity.onGround = false;
        entity.position = entity.position.offset(0,1.2,0);
    };
    bot.placeBlock = async (anchor, face) => {
        const cell = anchor.position.plus(face);
        assert.ok(entity.position.y > cell.y + 1);
        placements.add(cell.y);
        entity.position = cell.offset(0.5,1,0.5);
        entity.onGround = true;
    };
    assert.deepEqual(await run('pillar', '3'), { placed: 3, position: { x: 0.5, y: 67, z: 0.5 } });
    assert.deepEqual([...placements], [64,65,66]);
    bot.blockAt = previousBlockAt;
    bot.emit('end');
    assert.deepEqual(await run('status'), { state: 'disconnected' });
    bot = undefined;
    assert.deepEqual(await run('status'), { state: 'reconnecting' });
});

test('idle planner cycles between available actions and skips unavailable activities', () => {
    const position = { x: 4, y: 64, z: 1 };
    const options = { turn: 0, sites: [position], timber: { position }, nearby: 'neighbor' };
    assert.deepEqual(choose(options), { type: 'wander', target: position, next: 1 });
    assert.deepEqual(choose({ ...options, turn: 1 }), { type: 'gather', target: position, next: 2 });
    assert.deepEqual(choose({ ...options, turn: 2 }), { type: 'follow', target: 'neighbor', next: 0 });
    assert.equal(choose({ ...options, turn: 1, timber: { position, dropped: true } }).type, 'collect');
    assert.deepEqual(choose({ turn: 0, sites: [] }), { type: 'idle', next: 0 });
});

test('idle harvest accepts natural-looking trunks but not nearby construction or persistent leaves', () => {
    const origin = new Vec3(0, 64, 0);
    const trees = new Map([
        ['0,-1,0', 'dirt'], ['0,0,0', 'oak_log'], ['0,1,0', 'oak_log'], ['0,2,0', 'oak_log'],
        ['1,3,0', 'oak_leaves'], ['-1,3,0', 'oak_leaves'], ['0,3,1', 'oak_leaves'],
    ]);
    let persistent = false;
    const bot = { players: {}, blockAt(pos) {
        const name = trees.get(`${pos.x},${pos.y - 64},${pos.z}`) ?? 'air';
        return { name, getProperties: () => ({ persistent, axis: 'y' }) };
    } };
    assert.equal(naturalTrunk(bot, origin), true);
    trees.set('3,0,2', 'oak_planks');
    assert.equal(naturalTrunk(bot, origin), false);
    trees.delete('3,0,2');
    persistent = true;
    assert.equal(naturalTrunk(bot, origin), false);
});

test('an active idle goal is cancelled immediately when preempted', { timeout: 5000 }, async t => {
    const bot = Object.assign(new EventEmitter(), {
        username: 'devincraftbot', game: { gameMode: 'survival' }, health: 20, food: 20,
        entity: { position: new Vec3(0, 64, 0) }, players: {},
        blockAt: ({ y }) => y < 64 ? { name: 'stone', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' },
        pathfinder: { setGoal: goal => bot.emit('testGoal', goal) },
        clearControlStates() {},
    });
    const behavior = attachIdle(bot, {
        isIdle: () => true, isEnabled: () => true, setWalking() {}, log() {},
        greetings: { last: 0, players: new Map() },
    });
    t.after(() => behavior.close());
    const [planned] = await once(bot, 'testGoal');
    assert.ok(planned);
    assert.equal(behavior.status().type, 'wander');
    const cancelled = once(bot, 'testGoal');
    behavior.cancel(5000);
    assert.deepEqual(await cancelled, [null]);
    assert.deepEqual(behavior.status(), { type: 'idle' });
});

test('idle recovery eats safe inventory food before trying to walk', { timeout: 5000 }, async t => {
    const items = [{ name: 'pufferfish' }, { name: 'cooked_beef' }];
    const bot = Object.assign(new EventEmitter(), {
        username: 'devincraftbot', game: { gameMode: 'survival' }, health: 9, food: 17,
        entity: { position: new Vec3(0, 64, 0) }, registry: createRegistry('1.21.1'),
        inventory: { items: () => items },
        async equip(item) { this.heldItem = item; },
        async consume() { this.food = 20; this.emit('testAte', this.heldItem.name); },
        deactivateItem() {}, clearControlStates() {},
        pathfinder: { setGoal: goal => assert.equal(goal, null) },
    });
    const behavior = attachIdle(bot, {
        isIdle: () => true, isEnabled: () => true, setWalking: () => assert.fail('Must recover before walking'),
        log() {}, greetings: { last: 0, players: new Map() },
    });
    t.after(() => behavior.close());
    const keepAlive = setTimeout(() => {}, 4000);
    t.after(() => clearTimeout(keepAlive));
    const [food] = await once(bot, 'testAte');
    assert.equal(food, 'cooked_beef');
    items.pop();
    assert.equal(recoveryFood(bot), undefined);
});

test('an injured bot prioritizes food and clears a blocked apple pickup after five seconds', { timeout: 9000 }, async t => {
    const start = new Vec3(0.5,64,0.5), obstruction = new Vec3(1,64,0);
    const apple = { name: 'apple', count: 1 };
    const drop = { id: 1, position: start.offset(2,0,0), getDroppedItem: () => apple };
    const items = [];
    let blocked = true, started, dug;
    const bot = Object.assign(new EventEmitter(), {
        game: { gameMode: 'survival' }, entity: { position: start, onGround: true }, health: 11, food: 16,
        entities: { 1: drop }, registry: createRegistry('1.21.1'), recipesFor: () => [],
        inventory: { items: () => items }, nearestEntity: predicate => bot.entities[1] && predicate(drop) ? drop : undefined,
        blockAt(point) {
            const name = point.y < 64 || blocked && point.equals(obstruction) ? 'dirt' : 'air';
            return { name, position: point, boundingBox: name === 'air' ? 'empty' : 'block' };
        },
        world: { raycast: () => bot.blockAt(obstruction) },
        canDigBlock: block => block.position.equals(obstruction),
        async dig(block) {
            assert.ok(block.position.equals(obstruction));
            dug = Date.now();
            blocked = false;
        },
        async lookAt() {}, async equip(item) { this.heldItem = item; },
        async consume() { this.food = 20; this.emit('ate', this.heldItem); },
        setControlState(key, value) {
            if (key !== 'forward' || !value) return;
            assert.equal(blocked, false);
            this.entity.position = drop.position;
            items.push(apple);
            delete this.entities[1];
        },
        clearControlStates() {}, deactivateItem() {}, stopDigging() {},
        pathfinder: { setGoal() {} },
    });
    const behavior = attachIdle(bot, {
        isIdle: () => true, isEnabled: () => true, setWalking() {},
        log(line) { if (line.startsWith('Idle behavior: collect_food')) started ??= Date.now(); },
        greetings: { last: 0, players: new Map() },
    });
    t.after(() => behavior.close());
    assert.equal((await once(bot, 'ate'))[0], apple);
    assert.ok(dug >= started + 4900);
});

test('urgent mobs interrupt recovery; an armed bot swings at a zombie but flees a creeper', { timeout: 5000 }, async t => {
    const position = new Vec3(0, 64, 0);
    const hostile = { id: 1, name: 'zombie', type: 'hostile', position: position.offset(2, 0, 0) };
    const tool = { name: 'stone_sword', count: 1 };
    const bot = Object.assign(new EventEmitter(), {
        game: { gameMode: 'survival' }, entity: { position }, entities: { 1: hostile }, health: 16, food: 16,
        inventory: { items: () => [tool] },
        async equip(item) { this.heldItem = item; },
        async lookAt() {}, attack(target) { this.emit('swung', target); },
        setControlState() {}, clearControlStates() {},
        blockAt: p => p.y < 64 ? { name: 'stone', boundingBox: 'block' } : { name: 'air' },
        pathfinder: { setGoal() {} },
    });
    const behavior = attachIdle(bot, {
        isIdle: () => true, isEnabled: () => true, setWalking() {}, log() {},
        greetings: { last: 0, players: new Map() },
    });
    t.after(() => behavior.close());
    const [attacked] = await once(bot, 'swung');
    assert.equal(attacked, hostile);
    assert.equal(bot.heldItem, tool);
    assert.equal(behavior.status().type, 'fight');
    hostile.name = 'creeper';
    await new Promise(resolve => {
        const timer = setInterval(() => {
            if (behavior.status().type === 'flee') { clearInterval(timer); resolve(); }
        }, 20);
        t.after(() => clearInterval(timer));
    });
    assert.ok(behavior.status().target.x < 0);
    assert.equal(threatMode([{ name: 'skeleton' }], 8), 'cover');
    assert.equal(threatMode([{ name: 'zombie' }], 20), 'fight');
    assert.equal(threatMode(['zombie', 'husk', 'drowned'].map(name => ({ name })), 20), 'shelter');
});

test('a lone zombie is countered above 10 health; at 9.3 the bot retreats, and at 8 it pillars and waits', { timeout: 5000 }, async t => {
    const origin = new Vec3(0,64,0);
    const dirt = { name: 'dirt', count: 16, type: 10 };
    const sword = { name: 'stone_sword', count: 1 };
    const inventory = [sword];
    const blocks = new Map();
    const hostile = { id: 1, name: 'zombie', type: 'hostile', position: origin.offset(2.5,0,0.5) };
    const bot = Object.assign(new EventEmitter(), {
        game: { gameMode: 'survival' }, entity: { position: origin.offset(0.5,0,0.5) },
        entities: { 1: hostile }, health: 10.3, food: 20,
        inventory: { items: () => inventory }, heldItem: sword,
        async lookAt() {}, attack(target) { this.emit('counter', target); },
        clearControlStates() {}, setControlState() {},
        blockAt(point) {
            const name = blocks.get(point.toString()) ?? (point.y < 64 ? 'dirt' : 'air');
            return { name, position: point, boundingBox: name === 'air' ? 'empty' : 'block' };
        },
        canDigBlock: () => true,
        async dig(block) { this.emit('lower', block.position); },
        stopDigging() {},
        pathfinder: { movements: {}, setGoal(goal) {
            if (goal instanceof goals.GoalBlock) bot.emit('pillar', goal);
            else if (goal instanceof goals.GoalNear) bot.emit('retreat', goal);
        } },
    });
    const behavior = attachIdle(bot, {
        isIdle: () => true, isEnabled: () => true, setWalking() {}, log() {},
        greetings: { last: 0, players: new Map() },
    });
    t.after(() => behavior.close());
    assert.equal((await once(bot, 'counter'))[0], hostile);
    bot.health = 9.3;
    const [retreat] = await once(bot, 'retreat');
    assert.ok(retreat.x < origin.x);
    inventory.push(dirt);
    bot.health = 8;
    const [goal] = await once(bot, 'pillar');
    assert.deepEqual([goal.x, goal.y, goal.z], [0,67,0]);
    assert.deepEqual(bot.pathfinder.movements.scafoldingBlocks, [dirt.type]);
    for (let y = 0; y < 3; y++) blocks.set(origin.offset(0,y,0).toString(), 'dirt');
    bot.entity.position = origin.offset(0.5,3,0.5);
    delete bot.entities[1];
    await new Promise(resolve => setTimeout(resolve, 600));
    assert.equal(behavior.status().type, 'shelter');
    bot.health = 16;
    assert.deepEqual((await once(bot, 'lower'))[0], origin.offset(0,2,0));
});

test('surface thunder triggers a sealed hole and night keeps it closed', { timeout: 5000 }, async t => {
    const origin = new Vec3(0,64,0);
    const blocks = new Map();
    const bot = Object.assign(new EventEmitter(), {
        game: { gameMode: 'survival', minY: 0, height: 96 },
        entity: { position: origin.offset(0.5,0,0.5) }, health: 20, food: 20,
        time: { isDay: true, timeOfDay: 1000 }, isRaining: true, thunderState: 1,
        inventory: { items: () => [{ name: 'dirt', count: 16 }, { name: 'stone_sword', count: 1 }] },
        blockAt(point) {
            const name = blocks.get(point.toString()) ?? (point.y < 64 ? 'dirt' : 'air');
            return { name, position: point, boundingBox: name === 'air' ? 'empty' : 'block' };
        },
        canDigBlock: () => true,
        async dig(block) {
            blocks.set(block.position.toString(), 'air');
            if (block.position.y < this.entity.position.y) this.entity.position = block.position.offset(0.5,0,0.5);
            else this.emit('opened', block.position);
        },
        stopDigging() {},
        async equip() {},
        async placeBlock(block, face) {
            const point = block.position.plus(face);
            blocks.set(point.toString(), 'dirt');
            this.emit('sealed', point);
        },
        clearControlStates() {}, pathfinder: { movements: {}, setGoal(goal) { if (goal) bot.emit('shelterExitStep', goal); } },
    });
    const behavior = attachIdle(bot, {
        isIdle: () => true, isEnabled: () => true, setWalking() {}, log() {},
        greetings: { last: 0, players: new Map() },
    });
    t.after(() => behavior.close());
    const [cap] = await once(bot, 'sealed');
    assert.equal(cap.y - bot.entity.position.y, 2);
    bot.isRaining = false;
    bot.time.timeOfDay = 15000;
    await new Promise(resolve => setTimeout(resolve, 600));
    assert.equal(behavior.status().type, 'shelter');
    assert.equal(bot.blockAt(cap).name, 'dirt');
    bot.time.timeOfDay = 1000;
    assert.deepEqual((await once(bot, 'opened'))[0], cap);
    const firstExit = origin.offset(1,-2,0);
    const secondExit = firstExit.offset(0,1,1);
    for (const point of [firstExit, secondExit])
        for (let y = 0; y <= 2; y++) blocks.set(point.offset(0,y,0).toString(), 'air');
    const [first] = await once(bot, 'shelterExitStep');
    assert.deepEqual([first.x, first.y, first.z], [firstExit.x, firstExit.y, firstExit.z]);
    bot.entity.position = firstExit.offset(0.5,0,0.5);
    bot.emit('goal_reached', first);
    const [second] = await once(bot, 'shelterExitStep');
    assert.deepEqual([second.x, second.y, second.z], [secondExit.x, secondExit.y, secondExit.z]);
});

for (const cause of ['dusk', 'a zombie 15 blocks away', 'a low cap overlapping the player', 'a seal placement timeout']) {
    test(`an unarmored bot digs once and places an overhead dirt cap at ${cause}`, { timeout: 5000 }, async t => {
        const entry = new Vec3(0,64,0);
        const feet = entry.offset(0,-1,0);
        const cap = entry.offset(0,1,0);
        const support = cap.offset(1,0,0);
        const dirt = { name: 'dirt', count: 16 };
        const actions = [];
        const lines = [];
        const blocks = new Map();
        const occupied = cause === 'a low cap overlapping the player';
        const timesOut = cause === 'a seal placement timeout';
        const bot = Object.assign(new EventEmitter(), {
            game: { gameMode: 'survival', minY: 0, height: 96 },
            entity: { position: entry.offset(0.5,0,0.5), onGround: true }, health: 20, food: 20,
            time: { isDay: true, timeOfDay: 1000 }, entities: {},
            inventory: { items: () => [dirt] },
            blockAt(point) {
                const name = blocks.get(point.toString()) ?? (point.y < 64 || point.equals(support)
                    || occupied && point.equals(support.offset(0,1,0)) ? 'dirt' : 'air');
                return { name, position: point, boundingBox: name === 'air' ? 'empty' : 'block' };
            },
            canDigBlock: () => true,
            async dig(block) {
                actions.push(['dig', block.position]);
                blocks.set(block.position.toString(), 'air');
                this.entity.position = block.position.offset(0.5,occupied ? 0.875 : 0,0.5);
            },
            stopDigging() {},
            async equip(item) { assert.equal(item, dirt); this.heldItem = item; },
            async look() {}, async lookAt() {},
            setControlState(control, value) {
                if (control !== 'jump' || !value) return;
                assert.ok(timesOut && this.entity.onGround);
                this.entity.onGround = false;
                this.entity.position = this.entity.position.offset(0,1.2,0);
            },
            async placeBlock(block, face) {
                const point = block.position.plus(face);
                actions.push(['place', point]);
                if (timesOut && point.equals(cap) && this.entity.onGround)
                    throw new Error('Event blockUpdate did not fire within timeout of 500ms');
                blocks.set(point.toString(), 'dirt');
                if (timesOut) {
                    assert.ok(this.entity.position.y > point.y + 1);
                    this.entity.position = point.offset(0.5,1,0.5);
                    this.entity.onGround = true;
                } else this.emit('sealed');
            },
            clearControlStates() {}, pathfinder: { setGoal() {} },
        });
        const behavior = attachIdle(bot, {
            isIdle: () => true, isEnabled: () => true, setWalking() {},
            log(line) {
                lines.push(line);
                if (line.startsWith('Shelter fallback pillar: landed')) bot.emit('sealed');
            },
            greetings: { last: 0, players: new Map() },
        });
        t.after(() => behavior.close());
        const sealed = once(bot, 'sealed');
        if (cause !== 'a zombie 15 blocks away') bot.time.timeOfDay = 12000;
        else bot.entities[1] = { type: 'hostile', name: 'zombie', position: bot.entity.position.offset(15,0,0) };
        await sealed;
        if (timesOut) {
            assert.match(lines.find(line => line.startsWith('Shelter seal failed')), /timeout of 500ms; reference=.* face=.* reach=/);
            assert.deepEqual(actions, [['dig', feet], ['place', cap],
                ...[0,1,2,3].map(y => ['place', feet.offset(0,y,0)])]);
            assert.equal(bot.entity.position.y, 67);
        } else assert.deepEqual(actions, [['dig', feet], ['place', occupied ? cap.offset(0,1,0) : cap]]);
        await new Promise(resolve => setTimeout(resolve, 550));
        assert.equal(behavior.status().type, 'shelter');
        assert.equal(bot.health, 20);
    });
}

test('an unarmed bot does not chase a hostile out of melee range', { timeout: 5000 }, async t => {
    const position = new Vec3(0,64,0);
    const hostile = { id: 1, name: 'zombie', type: 'hostile', position: position.offset(5,0,0) };
    const bot = Object.assign(new EventEmitter(), {
        game: { gameMode: 'survival' }, entity: { position }, entities: { 1: hostile }, players: {}, health: 20, food: 20,
        inventory: { items: () => [] },
        blockAt: () => ({ name: 'air' }),
        pathfinder: { setGoal(goal) { assert.ok(!goal); } },
        clearControlStates() {},
        attack() { assert.fail('An unarmed bot should not attack a distant zombie'); },
    });
    const behavior = attachIdle(bot, {
        isIdle: () => true, isEnabled: () => true, setWalking() {}, log() {},
        greetings: { last: 0, players: new Map() },
    });
    t.after(() => behavior.close());
    await new Promise(resolve => setTimeout(resolve, 600));
    assert.equal(behavior.status().type, 'idle');
});

test('unarmored archer cover places dirt across the bogged sightline before digging or fighting', { timeout: 5000 }, async t => {
    const entry = new Vec3(0,64,0);
    const hostile = { type: 'hostile', name: 'bogged', position: entry.offset(15.5,0,0.5) };
    const base = entry.offset(1,0,0), cover = base.offset(0,1,0);
    const dirt = { name: 'dirt', count: 16 };
    const placed = [];
    const bot = Object.assign(new EventEmitter(), {
        game: { gameMode: 'survival' }, entity: { position: entry.offset(0.5,0,0.5), onGround: true },
        entities: { 1: hostile }, health: 20, food: 20,
        inventory: { items: () => [dirt] },
        blockAt(point) {
            const name = point.y < 64 || placed.some(cell => cell.equals(point)) ? 'dirt' : 'air';
            return { name, position: point, boundingBox: name === 'air' ? 'empty' : 'block' };
        },
        world: { raycast(from, dir, distance) {
            for (let d = 0; d < distance; d += 0.125) {
                const cell = from.plus(dir.scaled(d)).floored();
                if (cell.equals(cover) && placed.some(point => point.equals(cell))) return { position: cell };
            }
            return null;
        } },
        canDigBlock: () => true, async dig() { assert.fail('Cover must go up before digging'); },
        async equip(item) { assert.equal(item, dirt); },
        async placeBlock(block, face) {
            placed.push(block.position.plus(face));
            if (placed.length === 2) this.emit('covered');
        },
        clearControlStates() {}, pathfinder: { setGoal() {} },
    });
    const behavior = attachIdle(bot, {
        isIdle: () => true, isEnabled: () => true, setWalking() {}, log() {},
        greetings: { last: 0, players: new Map() },
    });
    t.after(() => behavior.close());
    await once(bot, 'covered');
    assert.deepEqual(placed, [base, cover]);
    assert.equal(behavior.status().type, 'place_archer_cover');
    assert.ok(bot.world.raycast(entry.offset(0.5,1.53,0.5), new Vec3(1,0,0), 15));
});

test('an empty stage 1 inventory gathers dirt before harvesting wood', { timeout: 5000 }, async t => {
    const origin = new Vec3(0,64,0);
    const point = origin.offset(1,0,0);
    const bot = Object.assign(new EventEmitter(), {
        game: { gameMode: 'survival' }, entity: { position: origin.offset(0.5,0,0.5) },
        health: 20, food: 20, inventory: { items: () => [] },
        blockAt(p) {
            const name = p.equals(point) ? 'grass_block' : p.y < 64 ? 'dirt' : 'air';
            return { name, position: p, boundingBox: name === 'air' ? 'empty' : 'block' };
        },
        findBlocks: ({ matching }) => matching(bot.blockAt(point)) ? [point] : [],
        world: { raycast: (_from, _direction, _distance, matcher) => matcher ? bot.blockAt(point) : null },
        canDigBlock: () => true, async dig(block) { this.emit('dug', block.position); },
        stopDigging() {},
        clearControlStates() {}, pathfinder: { setGoal() {} },
    });
    const behavior = attachIdle(bot, {
        isIdle: () => true, isEnabled: () => true, setWalking() {}, log() {},
        greetings: { last: 0, players: new Map() },
    });
    t.after(() => behavior.close());
    assert.deepEqual((await once(bot, 'dug'))[0], point);
});

test('at night the bot seals both blocks behind its tenth underground tunnel step', { timeout: 8500 }, async t => {
    const origin = new Vec3(0,-58,0);
    const items = ['iron_pickaxe', 'stone_pickaxe', 'stone_sword', 'iron_helmet', 'iron_chestplate',
        'crafting_table', 'furnace'].map(name => ({ name, count: 1 }));
    items.push({ name: 'stick', count: 16 }, { name: 'dirt', count: 16 },
        { name: 'oak_log', count: 3 }, { name: 'cobblestone', count: 32 });
    const placed = [];
    let steps = 0;
    const bot = Object.assign(new EventEmitter(), {
        game: { gameMode: 'survival', dimension: 'overworld' }, time: { isDay: false },
        entity: { position: origin.offset(0.5,0,0.5) }, health: 20, food: 20,
        inventory: { items: () => items }, recipesFor: () => [], findBlocks: () => [], canDigBlock: () => false,
        blockAt(point) {
            const name = placed.some(cell => cell.equals(point)) ? 'dirt'
                : point.z === 0 && point.x >= 0 && [origin.y,origin.y + 1].includes(point.y) ? 'air' : 'stone';
            return { name, position: point, boundingBox: name === 'air' ? 'empty' : 'block' };
        },
        async equip() {},
        async placeBlock(reference, face) {
            placed.push(reference.position.plus(face));
            if (placed.length === 2) this.emit('sealed');
        },
        clearControlStates() {},
        pathfinder: { movements: {}, setGoal(goal) {
            if (!goal) return;
            steps++;
            bot.entity.position = new Vec3(goal.x + 0.5, goal.y, goal.z + 0.5);
            bot.emit('goal_reached');
        } },
    });
    const behavior = attachIdle(bot, {
        isIdle: () => true, isEnabled: () => true, setWalking() {}, log() {},
        greetings: { last: 0, players: new Map() },
    });
    t.after(() => behavior.close());
    await once(bot, 'sealed');
    assert.equal(steps, 10);
    assert.deepEqual(placed, [origin.offset(9,0,0), origin.offset(9,1,0)]);
});

test('a shielded bot blocks a visible stray at 15 blocks and retreats rather than rushing', { timeout: 5000 }, async t => {
    const position = new Vec3(0.5,-37,0.5);
    const hostile = { id: 1, name: 'stray', type: 'hostile', position: position.offset(15,0,0) };
    const slots = [];
    slots[45] = { name: 'shield' };
    const bot = Object.assign(new EventEmitter(), {
        game: { gameMode: 'survival' }, entity: { position }, entities: { 1: hostile }, health: 13, food: 20,
        inventory: { slots, items: () => [{ name: 'stone_sword', count: 1 }] },
        getEquipmentDestSlot: () => 45,
        activateItem(offhand) { this.emit('blocked', offhand); },
        deactivateItem() {},
        blockAt: p => p.y < -37 ? { name: 'stone', boundingBox: 'block' } : { name: 'air' },
        world: { raycast: (from, dir) => from.equals(hostile.position.offset(0,1.53,0)) && dir.z > 0.02 ? {} : null },
        async lookAt() {}, setControlState(key, value) { if (key === 'forward' && value) this.emit('retreat'); },
        clearControlStates() {},
        pathfinder: { setGoal(goal) { assert.ok(!(goal instanceof goals.GoalFollow)); } },
    });
    const behavior = attachIdle(bot, {
        isIdle: () => true, isEnabled: () => true, setWalking() {}, log() {}, greetings: { last: 0, players: new Map() },
    });
    t.after(() => behavior.close());
    const [[offhand]] = await Promise.all([once(bot, 'blocked'), once(bot, 'retreat')]);
    assert.equal(offhand, true);
    assert.equal(behavior.status().type, 'take_cover');
    assert.ok(behavior.status().target.z > position.z);
});

test('the first iron ingot goes to a shield and the shield goes in the offhand', { timeout: 5000 }, async t => {
    const position = new Vec3(0.5,17,0.5);
    const table = position.floored().offset(1,0,0);
    const registry = createRegistry('1.21.1');
    const slots = [];
    const items = ['iron_ingot', 'stone_pickaxe', 'stone_sword', 'furnace']
        .map(name => ({ name, count: 1 }));
    items.push({ name: 'oak_planks', count: 6 });
    const bot = Object.assign(new EventEmitter(), {
        registry, entity: { position }, game: { gameMode: 'survival', dimension: 'overworld' },
        health: 20, food: 20, inventory: { slots, items: () => items },
        getEquipmentDestSlot: name => name === 'off-hand' ? 45 : 36,
        blockAt: point => ({ position: point, name: point.equals(table) ? 'crafting_table' : 'air' }),
        world: { raycast: () => ({ position: table }) },
        canDigBlock: () => false,
        recipesFor: id => [{ id }],
        async craft(recipe, _count, bench) {
            assert.equal(recipe.id, registry.itemsByName.shield.id);
            assert.ok(bench.position.equals(table));
            items.splice(items.findIndex(i => i.name === 'iron_ingot'), 1);
            items.push({ name: 'shield', count: 1 });
        },
        async equip(item, destination) {
            assert.equal(item.name, 'shield');
            assert.equal(destination, 'off-hand');
            slots[45] = item;
        },
        clearControlStates() {}, pathfinder: { setGoal() {} },
    });
    const behavior = attachIdle(bot, {
        isIdle: () => true, isEnabled: () => true, setWalking() {},
        log(line) { if (line === 'Shield equipped in offhand') bot.emit('equippedShield'); },
        greetings: { last: 0, players: new Map() },
    });
    t.after(() => behavior.close());
    bot[Symbol.for('devincraft.diamond.goal')].station('crafting_table', table);
    await once(bot, 'equippedShield');
    assert.equal(slots[45].name, 'shield');
    assert.ok(!items.some(item => item.name === 'iron_ingot'));
});

test('bed setup waits for daylight and safe sheep before replacing a missing bed and confirming sleep', { timeout: 16000 }, async t => {
    const origin = new Vec3(0,64,0), foot = origin.offset(1,0,0), head = foot.offset(1,0,0);
    const table = origin.offset(0,0,1);
    const registry = createRegistry('1.21.1');
    const slots = [];
    slots[45] = { name: 'shield' };
    const items = [{ name: 'white_wool', count: 2 }, { name: 'red_wool', count: 1 },
        { name: 'oak_planks', count: 8 }, { name: 'dirt', count: 16 }, { name: 'stone_sword', count: 1 }];
    const sheep = { id: 1, name: 'sheep', type: 'animal', position: origin.offset(0.5,0,-4.5), metadata: [] };
    const archer = { id: 2, name: 'skeleton', type: 'hostile', position: sheep.position.offset(0,0,-24) };
    let placed = false, aim, equipped, slept = false, hunts = 0;
    const bot = Object.assign(new EventEmitter(), {
        registry, entity: { position: origin.offset(0.5,0,0.5), onGround: true },
        game: { gameMode: 'survival', dimension: 'overworld', minY: 0, height: 100 },
        time: { timeOfDay: 15000 }, health: 20, food: 20, entities: { 1: sheep }, players: {},
        inventory: { slots, items: () => items },
        getEquipmentDestSlot: name => name === 'off-hand' ? 45 : 36,
        nearestEntity: predicate => Object.values(bot.entities).find(predicate),
        findBlocks: () => [],
        canDigBlock: () => false,
        blockAt(point) {
            const onSite = point.x === 1 || point.x === 2;
            const wall = point.y >= origin.y && point.y <= origin.y + 1 && onSite && Math.abs(point.z) === 1;
            const roof = point.y === origin.y + 2 && onSite && point.z === 0;
            const name = point.equals(table) ? 'crafting_table'
                : placed && (point.equals(foot) || point.equals(head)) ? 'white_bed'
                    : wall || roof || point.y < origin.y ? 'stone' : 'air';
            return { position: point, name, boundingBox: name === 'air' ? 'empty' : 'block' };
        },
        world: { raycast: (_from, _direction, _length, predicate) => predicate ? bot.blockAt(table) : null },
        recipesFor: id => [{ id }],
        async craft(recipe) {
            assert.equal(recipe.id, registry.itemsByName.white_bed.id);
            assert.equal(items.find(item => item.name === 'white_wool').count, 3);
            items.push({ name: 'white_bed', count: 1 });
        },
        async lookAt(point) { aim = point; },
        async equip(item) { equipped = item.name; },
        attack(entity) {
            assert.equal(entity, sheep);
            assert.equal(equipped, 'stone_sword');
            delete this.entities[sheep.id];
            items.find(item => item.name === 'white_wool').count++;
            this.time.timeOfDay = 15000;
        },
        async _placeBlockWithOptions(reference, face, options) {
            assert.equal(equipped, 'white_bed');
            assert.ok(reference.position.plus(face).equals(foot));
            assert.ok(aim.x - this.entity.position.x > 0.9);
            assert.equal(options.forceLook, 'ignore');
            placed = true;
        },
        async sleep(block) {
            assert.ok(placed && block.position.equals(foot));
            assert.equal(bot[Symbol.for('devincraft.diamond.goal')].bed().spawnSet, false);
            slept = this.isSleeping = true;
        },
        pathfinder: { movements: {}, setGoal(goal) {
            this.goal = goal;
            if (goal instanceof goals.GoalFollow) {
                hunts++;
                sheep.position = origin.offset(0.5,0,-1.5);
            }
        } },
        clearControlStates() {},
    });
    const behavior = attachIdle(bot, {
        isIdle: () => true, isEnabled: () => true, setWalking() {}, greetings: { last: 0, players: new Map() },
        log(line) { if (line.startsWith('Bed spawn set at ')) bot.emit('bedSpawn'); },
    });
    t.after(() => behavior.close());
    const goal = bot[Symbol.for('devincraft.diamond.goal')];
    goal.station('crafting_table', table);
    goal.setBed({ name: 'white_bed', foot: { ...foot }, head: { ...head }, stand: { ...origin },
        dimension: 'overworld', spawnSet: true });
    await new Promise(resolve => setTimeout(resolve, 700));
    assert.equal(hunts, 0);
    bot.entities[archer.id] = archer;
    bot.time.timeOfDay = 6000;
    await new Promise(resolve => setTimeout(resolve, 2600));
    assert.equal(hunts, 0);
    archer.name = 'bogged';
    await new Promise(resolve => setTimeout(resolve, 2600));
    assert.equal(hunts, 0);
    delete bot.entities[archer.id];
    await once(bot, 'bedSpawn');
    assert.equal(hunts, 1);
    assert.ok(slept);
    assert.equal(goal.bed().spawnSet, true);
    bot.emit('spawnReset');
    assert.equal(goal.bed().spawnSet, false);
});

test('three matching wool and planks prioritize a bed over an otherwise craftable shield', { timeout: 5000 }, async t => {
    const origin = new Vec3(0,64,0), table = origin.offset(0,0,1);
    const registry = createRegistry('1.21.1');
    const items = [{ name: 'white_wool', count: 3 }, { name: 'oak_planks', count: 6 }, { name: 'iron_ingot', count: 1 }];
    const bot = Object.assign(new EventEmitter(), {
        registry, entity: { position: origin.offset(0.5,0,0.5), onGround: true },
        game: { gameMode: 'survival', dimension: 'overworld', minY: 0, height: 70 },
        time: { timeOfDay: 2000 }, health: 20, food: 20, entities: {}, players: {},
        inventory: { slots: [], items: () => items },
        getEquipmentDestSlot: () => 45,
        blockAt(point) {
            const name = point.equals(table) ? 'crafting_table' : point.y < 64 ? 'dirt' : 'air';
            return { position: point, name, boundingBox: name === 'air' ? 'empty' : 'block' };
        },
        world: { raycast: () => bot.blockAt(table) },
        recipesFor: id => [{ id }],
        async craft(recipe) { this.emit('crafted', recipe.id); },
        async sleep() {}, async _placeBlockWithOptions() {}, async equip() {},
        pathfinder: { setGoal() {} }, clearControlStates() {},
    });
    const behavior = attachIdle(bot, {
        isIdle: () => true, isEnabled: () => true, setWalking() {}, log() {}, greetings: { last: 0, players: new Map() },
    });
    t.after(() => behavior.close());
    bot[Symbol.for('devincraft.diamond.goal')].station('crafting_table', table);
    assert.equal((await once(bot, 'crafted'))[0], registry.itemsByName.white_bed.id);
});

for (const timedOut of [false, true]) test(timedOut
    ? 'a ten-minute sheep search lets the saved base craft a shield and retry the bed later'
    : 'at the saved base, a bed must set spawn before the first iron ingot becomes a shield', { timeout: 7000 }, async t => {
    const origin = new Vec3(0,64,0), foot = origin.offset(1,0,0), head = foot.offset(1,0,0), table = origin.offset(0,0,1);
    const registry = createRegistry('1.21.1'), slots = [], events = [];
    const items = ['iron_ingot', 'stone_pickaxe', 'stone_sword', 'furnace'].map(name => ({ name, count: 1 }));
    items.push({ name: 'oak_planks', count: 6 }, { name: 'dirt', count: 16 });
    const bot = Object.assign(new EventEmitter(), {
        registry, entity: { position: origin.offset(0.5,0,0.5), onGround: true },
        game: { gameMode: 'survival', dimension: 'overworld', minY: 0, height: 75 },
        time: { timeOfDay: 3000 }, health: 20, food: 20, entities: {}, players: {},
        inventory: { slots, items: () => items },
        getEquipmentDestSlot: () => 45,
        blockAt(point) {
            const name = point.equals(table) ? 'crafting_table'
                : (!timedOut || bot.time.timeOfDay === 15000) && (point.equals(foot) || point.equals(head)) ? 'white_bed'
                    : point.y < origin.y ? 'stone' : 'air';
            return { position: point, name, boundingBox: name === 'air' ? 'empty' : 'block' };
        },
        world: { raycast: () => bot.blockAt(table) },
        findBlocks: () => [],
        recipesFor: id => [{ id }],
        async craft(recipe) {
            assert.equal(recipe.id, registry.itemsByName.shield.id);
            events.push('craft');
            items.push({ name: 'shield', count: 1 });
        },
        async sleep() { this.isSleeping = true; events.push('sleep'); },
        async _placeBlockWithOptions() {},
        async equip(item, destination) {
            assert.equal(destination, 'off-hand');
            slots[45] = item;
            events.push('equip');
            this.emit('shieldEquipped');
        },
        pathfinder: { setGoal() {} }, clearControlStates() {},
    });
    const behavior = attachIdle(bot, {
        isIdle: () => true, isEnabled: () => true, setWalking() {}, greetings: { last: 0, players: new Map() },
        log(line) {
            if (line.startsWith('Bed spawn set at ')) {
                bot.isSleeping = false;
                bot.emit('bedSpawnSet');
            }
        },
    });
    t.after(() => behavior.close());
    const goal = bot[Symbol.for('devincraft.diamond.goal')];
    goal.station('crafting_table', table);
    goal.setSpawnRelocation({ origin: { ...origin }, base: { ...origin },
        bedSearchStartedAt: timedOut ? Date.now() - 10 * 60_000 : undefined });
    const placeBed = () => goal.setBed({ name: 'white_bed', foot: { ...foot }, head: { ...head }, stand: { ...origin },
        dimension: 'overworld', spawnSet: false });
    if (timedOut) {
        await once(bot, 'shieldEquipped');
        assert.deepEqual(events, ['craft', 'equip']);
        placeBed();
        bot.time.timeOfDay = 15000;
        await once(bot, 'bedSpawnSet');
        assert.deepEqual(events, ['craft', 'equip', 'sleep']);
        assert.equal(goal.bed().spawnSet, true);
        return;
    }
    placeBed();
    await new Promise(resolve => setTimeout(resolve, 700));
    assert.deepEqual(events, []);
    assert.ok(goal.snapshot().blockers.includes('Waiting for a safe night to set bed spawn'));
    bot.time.timeOfDay = 15000;
    await once(bot, 'shieldEquipped');
    assert.deepEqual(events, ['sleep', 'craft', 'equip']);
    assert.equal(goal.bed().spawnSet, true);
});

test('the first respawn returns to the saved base before looking for food or gear', { timeout: 7000 }, async t => {
    const start = new Vec3(0,64,0), base = start.offset(-3,0,1), steps = [];
    let aim, died = false, foodSearches = 0;
    const bot = Object.assign(new EventEmitter(), {
        registry: createRegistry('1.21.1'), entity: { position: start.offset(0.5,0,0.5), onGround: true },
        game: { gameMode: 'survival', dimension: 'overworld', minY: 0, height: 70 },
        health: 20, food: 15, entities: {}, players: {}, inventory: { items: () => [] },
        nearestEntity() { foodSearches++; },
        blockAt(point) {
            const name = point.y < 64 ? 'dirt' : 'air';
            return { position: point, name, boundingBox: name === 'air' ? 'empty' : 'block' };
        },
        async lookAt(target) { aim = target; },
        setControlState(name, enabled) {
            if (name !== 'forward' || !enabled) return;
            const next = new Vec3(aim.x, start.y, aim.z);
            steps.push(next.floored());
            this.entity.position = next;
        },
        pathfinder: { setGoal() {} }, clearControlStates() {},
    });
    const behavior = attachIdle(bot, {
        isIdle: () => true, isEnabled: () => died, setWalking() {}, greetings: { last: 0, players: new Map() },
        log(line) { if (line.startsWith('Returned to saved jungle base')) bot.emit('returned', foodSearches); },
    });
    t.after(() => behavior.close());
    const goal = bot[Symbol.for('devincraft.diamond.goal')];
    goal.setSpawnRelocation({ origin: { ...start }, base: { ...base }, heading: [1,0] });
    const returned = once(bot, 'returned');
    bot.emit('death');
    died = true;
    assert.equal((await returned)[0], 0);
    assert.deepEqual(steps.at(-1), base);
    assert.deepEqual(goal.spawnRelocation().base, { ...base });
    assert.equal(goal.spawnRelocation().escape, null);
    assert.ok(foodSearches > 0);
});

for (const [scenario, support, below, waterlogged] of [
    ['one-block landings', 'jungle_leaves', 'jungle_log', false],
    ['fluid below', 'jungle_leaves', 'water', false],
    ['an air gap deeper than three', 'jungle_leaves', 'air', false],
    ['waterlogged support', 'jungle_leaves', 'jungle_log', true],
    ['a non-canopy support', 'oak_planks', 'jungle_log', false],
]) {
    test(`saved-base canopy dig-down handles ${scenario}`, { timeout: 10_000 }, async t => {
        const y = 64, start = new Vec3(0,y+3,0), base = new Vec3(-2,y,0);
        const digs = [], cleared = new Set();
        let aim;
        const bot = Object.assign(new EventEmitter(), {
            registry: createRegistry('1.21.1'), entity: { position: start.offset(0.5,0,0.5), onGround: true },
            game: { gameMode: 'survival', dimension: 'overworld', minY: 0, height: 75 },
            health: 20, food: 20, entities: {}, players: {}, inventory: { items: () => [] },
            blockAt(point) {
                const inColumn = point.x === 0 && point.z === 0;
                const name = cleared.has(point.toString()) ? 'air'
                    : inColumn && point.y === y+2 ? support
                    : inColumn && point.y === y+1 ? below
                    : inColumn && point.y === y && below === 'jungle_log' ? 'rooted_dirt'
                    : point.y === y-1 && scenario === 'one-block landings' ? 'grass_block' : 'air';
                return { position: point, name, boundingBox: ['air','water'].includes(name) ? 'empty' : 'block',
                    getProperties: () => ({ waterlogged: waterlogged && name === support }) };
            },
            async lookAt(target) { aim = target; },
            setControlState(name, enabled) {
                if (name === 'forward' && enabled) this.entity.position = new Vec3(aim.x, y, aim.z);
            },
            canDigBlock() { return true; },
            async dig(block) {
                assert.deepEqual(block.position, this.entity.position.floored().offset(0,-1,0));
                digs.push(block.name);
                cleared.add(block.position.toString());
                this.entity.onGround = false;
                setTimeout(() => {
                    this.entity.position = this.entity.position.offset(0,-1,0);
                    this.entity.onGround = true;
                }, 70);
            },
            pathfinder: { setGoal() {} }, clearControlStates() {},
        });
        const behavior = attachIdle(bot, {
            isIdle: () => true, isEnabled: () => true, setWalking() {}, greetings: { last: 0, players: new Map() },
            log(line) { if (line.startsWith('Returned to saved jungle base')) bot.emit('returned'); },
        });
        t.after(() => behavior.close());
        const goal = bot[Symbol.for('devincraft.diamond.goal')];
        goal.setSpawnRelocation({ origin: { ...start }, base: { ...base }, escape: { origin: { ...start }, destination: { ...base } } });
        if (scenario === 'one-block landings') {
            await once(bot, 'returned');
            assert.deepEqual(digs, ['jungle_leaves', 'jungle_log', 'rooted_dirt']);
            assert.deepEqual(bot.entity.position.floored(), base);
        } else {
            await new Promise(resolve => setTimeout(resolve, 1100));
            assert.ok(goal.status().blockers.some(line => line.startsWith('Spawn dig-down blocked')));
            assert.deepEqual(digs, []);
            assert.deepEqual(bot.entity.position.floored(), start);
        }
    });
}

for (const rise of [0,1]) test(`saved-base escape clears a leaf obstruction and verifies a supported drop after a ${rise ? 'jump' : 'level step'}`, { timeout: 8000 }, async t => {
    const start = new Vec3(0,70,0), trunk = new Vec3(1,70+rise,0), landing = trunk.offset(0,-2,0);
    const base = landing.offset(1,0,0);
    const head = trunk.offset(0,1,0), log = trunk.offset(0,-1,0);
    const blocks = new Map([[start.offset(0,-1,0), 'mangrove_leaves'], [head, 'mangrove_leaves'],
        [trunk, 'mangrove_leaves'], [log, 'mangrove_log'], [landing.offset(0,-1,0), 'grass_block'],
        [base.offset(0,-1,0), 'grass_block']].map(([point,name]) => [point.toString(),name]));
    const digs = [];
    let aim, jumping = false;
    const bot = Object.assign(new EventEmitter(), {
        registry: createRegistry('1.21.1'), entity: { position: start.offset(0.5,0,0.5), onGround: true },
        game: { gameMode: 'survival', dimension: 'overworld', minY: 0, height: 75 },
        health: 20, food: 20, entities: {}, players: {}, inventory: { items: () => [] },
        blockAt(point) {
            const name = blocks.get(point.toString()) ?? 'air';
            return { position: point, name, boundingBox: name === 'air' ? 'empty' : 'block',
                getProperties: () => ({ persistent: false }) };
        },
        async lookAt(target) { aim = target; },
        setControlState(name, enabled) {
            if (name === 'jump') jumping = enabled;
            if (name === 'forward' && enabled) {
                const target = Math.floor(aim.x) === trunk.x ? trunk : base;
                if (target === trunk && rise) assert.ok(jumping, 'start forward movement before the jump peaks');
                assert.equal(this.blockAt(target).name, 'air');
                assert.equal(this.blockAt(target.offset(0,1,0)).name, 'air');
                this.entity.position = target.offset(0.5,0,0.5);
            }
        },
        canDigBlock() { return true; },
        async dig(block) {
            digs.push(block.position);
            blocks.delete(block.position.toString());
            if (block.position.equals(log)) {
                assert.deepEqual(this.entity.position.floored(), trunk);
                this.entity.position = landing.offset(0.5,0,0.5);
            }
        },
        pathfinder: { setGoal() {} }, clearControlStates() {},
    });
    const behavior = attachIdle(bot, {
        isIdle: () => true, isEnabled: () => true, setWalking() {}, greetings: { last: 0, players: new Map() },
        log(line) { if (line.startsWith('Returned to saved jungle base')) bot.emit('returned'); },
    });
    t.after(() => behavior.close());
    const goal = bot[Symbol.for('devincraft.diamond.goal')];
    goal.setSpawnRelocation({ origin: { ...start }, base: { ...base }, escape: { origin: { ...start }, destination: { ...base } } });
    await once(bot, 'returned');
    assert.deepEqual(digs, [head, trunk, log]);
    assert.deepEqual(bot.entity.position.floored(), base);
});

test('saved-base escape uses a supported lower ledge when there is no canopy dig-down', { timeout: 6000 }, async t => {
    const start = new Vec3(0,69,0), landing = new Vec3(1,66,0), base = new Vec3(2,66,0);
    const moves = [];
    let aim;
    const bot = Object.assign(new EventEmitter(), {
        registry: createRegistry('1.21.1'), entity: { position: start.offset(0.5,0,0.5), onGround: true },
        game: { gameMode: 'survival', dimension: 'overworld', minY: 0, height: 75 },
        health: 20, food: 20, entities: {}, players: {}, inventory: { items: () => [] },
        blockAt(point) {
            const name = start.offset(0,-1,0).equals(point) ? 'mangrove_leaves'
                : [landing, base].some(cell => cell.offset(0,-1,0).equals(point)) ? 'grass_block' : 'air';
            return { position: point, name, boundingBox: name === 'air' ? 'empty' : 'block',
                getProperties: () => ({ persistent: false }) };
        },
        async lookAt(target) { aim = target; },
        setControlState(name, enabled) {
            if (name !== 'forward' || !enabled) return;
            const cell = [landing, base].find(p => p.x === Math.floor(aim.x));
            assert.ok(cell);
            moves.push(cell);
            this.entity.position = cell.offset(0.5,0,0.5);
        },
        canDigBlock() { return true; },
        async dig() { assert.fail('never dig the leaf above the unsupported gap'); },
        pathfinder: { setGoal() {} }, clearControlStates() {},
    });
    const behavior = attachIdle(bot, {
        isIdle: () => true, isEnabled: () => true, setWalking() {}, greetings: { last: 0, players: new Map() },
        log(line) { if (line.startsWith('Returned to saved jungle base')) bot.emit('returned'); },
    });
    t.after(() => behavior.close());
    const goal = bot[Symbol.for('devincraft.diamond.goal')];
    goal.setSpawnRelocation({ origin: { ...start }, base: { ...base }, escape: { origin: { ...start }, destination: { ...base } } });
    await once(bot, 'returned');
    assert.deepEqual(moves, [landing, base]);
});

test('saved-base escape takes a lower canopy ledge that opens a safe dig column', { timeout: 7500 }, async t => {
    const start = new Vec3(0,69,0), ledge = new Vec3(1,66,0), landing = ledge.offset(0,-3,0), base = new Vec3(2,62,0);
    const moves = [];
    let aim, dug = false;
    const bot = Object.assign(new EventEmitter(), {
        registry: createRegistry('1.21.1'), entity: { position: start.offset(0.5,0,0.5), onGround: true },
        game: { gameMode: 'survival', dimension: 'overworld', minY: 0, height: 75 },
        time: { timeOfDay: 6000 }, health: 20, food: 20, entities: {}, players: {}, inventory: { items: () => [] },
        blockAt(point) {
            const name = start.offset(0,-1,0).equals(point) || !dug && ledge.offset(0,-1,0).equals(point) ? 'jungle_leaves'
                : [landing, base].some(cell => cell.offset(0,-1,0).equals(point)) ? 'grass_block' : 'air';
            return { position: point, name, boundingBox: name === 'air' ? 'empty' : 'block',
                getProperties: () => ({ persistent: false }) };
        },
        async lookAt(target) { aim = target; },
        setControlState(name, enabled) {
            if (name !== 'forward' || !enabled) return;
            const cell = [ledge, base].find(p => p.x === Math.floor(aim.x));
            assert.ok(cell);
            moves.push(cell);
            this.entity.position = cell.offset(0.5,0,0.5);
        },
        canDigBlock() { return true; },
        async dig(block) {
            assert.deepEqual(block.position, ledge.offset(0,-1,0));
            dug = true;
            this.entity.position = landing.offset(0.5,0,0.5);
        },
        pathfinder: { setGoal() {} }, clearControlStates() {},
    });
    const behavior = attachIdle(bot, {
        isIdle: () => true, isEnabled: () => true, setWalking() {}, greetings: { last: 0, players: new Map() },
        log(line) { if (line.startsWith('Returned to saved jungle base')) bot.emit('returned'); },
    });
    t.after(() => behavior.close());
    bot[Symbol.for('devincraft.diamond.goal')].setSpawnRelocation({ origin: { ...start }, base: { ...base },
        escape: { origin: { ...start }, destination: { ...base } } });
    await once(bot, 'returned');
    assert.equal(dug, true);
    assert.deepEqual(moves, [ledge, base]);
});

test('saved-base return clears a dry rise after a stalled jump', { timeout: 6500 }, async t => {
    const start = new Vec3(0,69,0), step = start.offset(1,0,0), base = step.offset(1,0,0);
    let aim, cleared = false, triedJump = false;
    const bot = Object.assign(new EventEmitter(), {
        registry: createRegistry('1.21.1'), entity: { position: start.offset(0.5,0,0.5), onGround: true },
        game: { gameMode: 'survival', dimension: 'overworld', minY: 0, height: 75 },
        time: { timeOfDay: 6000 }, health: 20, food: 20, entities: {}, players: {}, inventory: { items: () => [] },
        blockAt(point) {
            const solid = !cleared && point.equals(step) || [start,step,base].some(cell => cell.offset(0,-1,0).equals(point));
            return { position: point, name: solid ? 'grass_block' : 'air', boundingBox: solid ? 'block' : 'empty' };
        },
        world: { raycast: () => bot.blockAt(step) },
        async lookAt(target) { aim = target; },
        setControlState(name, enabled) {
            if (name === 'jump' && enabled) triedJump = true;
            if (name === 'forward' && enabled && cleared) this.entity.position = new Vec3(aim.x, start.y, aim.z);
        },
        canDigBlock: () => true,
        async dig(block) {
            assert.equal(triedJump, true);
            assert.deepEqual(block.position, step);
            cleared = true;
        },
        pathfinder: { setGoal() {} }, clearControlStates() {},
    });
    const behavior = attachIdle(bot, {
        isIdle: () => true, isEnabled: () => true, setWalking() {}, greetings: { last: 0, players: new Map() },
        log(line) { if (line.startsWith('Returned to saved jungle base')) bot.emit('returned'); },
    });
    t.after(() => behavior.close());
    bot[Symbol.for('devincraft.diamond.goal')].setSpawnRelocation({ origin: { ...start }, base: { ...base },
        escape: { origin: { ...start }, destination: { ...base } } });
    await once(bot, 'returned');
    assert.equal(cleared, true);
});

test('saved-base return carves one jumpable step out of a dry mud pocket', { timeout: 6500 }, async t => {
    const start = new Vec3(0,68,0), step = start.offset(-1,1,0), base = step.offset(-1,0,0);
    let aim, dug = false, jumping = false;
    const bot = Object.assign(new EventEmitter(), {
        registry: createRegistry('1.21.1'), entity: { position: start.offset(0.5,0,0.5), onGround: true },
        game: { gameMode: 'survival', dimension: 'overworld', minY: 0, height: 75 },
        time: { timeOfDay: 6000 }, health: 20, food: 20, entities: {}, players: {}, inventory: { items: () => [] },
        blockAt(point) {
            const solid = !dug && point.equals(step) || [start,step,base].some(cell => cell.offset(0,-1,0).equals(point));
            return { position: point, name: solid ? 'mud' : 'air', boundingBox: solid ? 'block' : 'empty' };
        },
        world: { raycast: () => bot.blockAt(step) },
        async lookAt(target) { aim = target; },
        setControlState(name, enabled) {
            if (name === 'jump' && enabled) { assert.equal(dug, true); jumping = true; }
            if (name === 'forward' && enabled) {
                assert.equal(jumping, true);
                this.entity.position = new Vec3(aim.x, step.y, aim.z);
            }
        },
        canDigBlock: () => true,
        async dig(block) {
            assert.equal(jumping, false);
            assert.deepEqual(block.position, step);
            dug = true;
        },
        pathfinder: { setGoal() {} }, clearControlStates() {},
    });
    const behavior = attachIdle(bot, {
        isIdle: () => true, isEnabled: () => true, setWalking() {}, greetings: { last: 0, players: new Map() },
        log(line) { if (line.startsWith('Returned to saved jungle base')) bot.emit('returned'); },
    });
    t.after(() => behavior.close());
    bot[Symbol.for('devincraft.diamond.goal')].setSpawnRelocation({ origin: { ...start }, base: { ...base },
        escape: { origin: { ...start }, destination: { ...base } } });
    await once(bot, 'returned');
    assert.equal(dug, true);
});

test('saved-base escape clears leaves and dry roots blocking consecutive ground steps', { timeout: 6500 }, async t => {
    const start = new Vec3(0,69,0), west = start.offset(-1,0,0), turn = west.offset(0,0,-1), base = turn.offset(-1,0,0);
    const obstacles = [west.offset(0,1,0), turn.offset(0,1,0)];
    const cuts = [], moves = [];
    let aim;
    const bot = Object.assign(new EventEmitter(), {
        registry: createRegistry('1.21.1'), entity: { position: start.offset(0.5,0,0.5), onGround: true },
        game: { gameMode: 'survival', dimension: 'overworld', minY: 0, height: 75 },
        time: { timeOfDay: 6000 }, health: 20, food: 20, entities: {}, players: {}, inventory: { items: () => [] },
        blockAt(point) {
            const obstacle = obstacles.findIndex(cell => cell.equals(point));
            const floor = [start,west,turn,base].some(cell => cell.offset(0,-1,0).equals(point));
            const name = floor ? 'mud' : obstacle >= cuts.length ? ['mangrove_leaves', 'mangrove_roots'][obstacle] : 'air';
            return { position: point, name, boundingBox: name === 'air' ? 'empty' : 'block', getProperties: () => ({}) };
        },
        world: { raycast: () => bot.blockAt(obstacles[cuts.length]) },
        async lookAt(target) { aim = target; },
        setControlState(name, enabled) {
            if (name !== 'forward' || !enabled) return;
            this.entity.position = new Vec3(aim.x, start.y, aim.z);
            moves.push(this.entity.position.floored());
        },
        canDigBlock: () => true,
        async dig(block) {
            assert.deepEqual(block.position, obstacles[cuts.length]);
            cuts.push(block.position);
        },
        pathfinder: { setGoal() {} }, clearControlStates() {},
    });
    const behavior = attachIdle(bot, {
        isIdle: () => true, isEnabled: () => true, setWalking() {}, greetings: { last: 0, players: new Map() },
        log(line) { if (line.startsWith('Returned to saved jungle base')) bot.emit('returned'); },
    });
    t.after(() => behavior.close());
    bot[Symbol.for('devincraft.diamond.goal')].setSpawnRelocation({ origin: { ...start }, base: { ...base },
        escape: { origin: { ...start }, destination: { ...base } } });
    await once(bot, 'returned');
    assert.deepEqual(cuts, obstacles);
    assert.deepEqual(moves, [west, turn, base]);
});

test('saved-base escape walks down dry mangrove root ledges without digging them', { timeout: 7000 }, async t => {
    const route = [[0,69], [1,69], [2,66], [3,64], [4,64]].map(([x,y]) => new Vec3(x,y,0));
    const start = route[0], base = route.at(-1), landings = [];
    let aim;
    const bot = Object.assign(new EventEmitter(), {
        registry: createRegistry('1.21.1'), entity: { position: start.offset(0.5,0,0.5), onGround: true },
        game: { gameMode: 'survival', dimension: 'overworld', minY: 0, height: 75 },
        health: 20, food: 20, entities: {}, players: {}, inventory: { items: () => [] },
        blockAt(point) {
            const index = route.findIndex(cell => cell.offset(0,-1,0).equals(point));
            const name = index >= 3 ? 'mud' : index >= 0 ? 'mangrove_roots' : 'air';
            return { position: point, name, boundingBox: name === 'air' ? 'empty' : 'block' };
        },
        async lookAt(target) { aim = target; },
        setControlState(name, enabled) {
            if (name !== 'forward' || !enabled) return;
            const cell = route.find(p => p.x === Math.floor(aim.x) && p.z === Math.floor(aim.z));
            assert.ok(cell);
            landings.push(cell);
            this.entity.position = cell.offset(0.5,0,0.5);
        },
        canDigBlock() { return true; },
        async dig() { assert.fail('root escape should not dig'); },
        pathfinder: { setGoal() {} }, clearControlStates() {},
    });
    const behavior = attachIdle(bot, {
        isIdle: () => true, isEnabled: () => true, setWalking() {}, greetings: { last: 0, players: new Map() },
        log(line) { if (line.startsWith('Returned to saved jungle base')) bot.emit('returned'); },
    });
    t.after(() => behavior.close());
    const goal = bot[Symbol.for('devincraft.diamond.goal')];
    goal.setSpawnRelocation({ origin: { ...start }, base: { ...base }, escape: { origin: { ...start }, destination: { ...base } } });
    await once(bot, 'returned');
    assert.deepEqual(landings, route.slice(1));
    assert.equal(goal.spawnRelocation().escape, null);
});

test('saved-base descent waits and places dirt cover above a hostile landing, then resumes in daylight', { timeout: 8000 }, async t => {
    const start = new Vec3(0,67,0), landing = new Vec3(1,64,0), base = new Vec3(2,64,0);
    const wall = start.offset(0,0,1), dirt = { name: 'dirt', count: 1 };
    const enemy = { name: 'zombie', type: 'hostile', position: landing.offset(0.5,0,12) };
    const placed = [], landings = [];
    let aim;
    const bot = Object.assign(new EventEmitter(), {
        registry: createRegistry('1.21.1'), entity: { position: start.offset(0.5,0,0.5), onGround: true },
        game: { gameMode: 'survival', dimension: 'overworld', minY: 0, height: 75 },
        time: { isDay: true, timeOfDay: 6000 },
        health: 20, food: 20, entities: { 1: enemy }, players: {}, inventory: { items: () => [dirt] },
        blockAt(point) {
            const name = placed.some(cell => cell.equals(point)) ? 'dirt'
                : start.offset(0,-1,0).equals(point) ? 'mangrove_roots'
                : [landing, base].some(cell => cell.offset(0,-1,0).equals(point)) ? 'mud'
                : wall.offset(0,-1,0).equals(point) ? 'polished_andesite' : 'air';
            return { position: point, name, boundingBox: name === 'air' ? 'empty' : 'block' };
        },
        async equip(item, destination) {
            assert.equal(item, dirt);
            assert.equal(destination, 'hand');
        },
        async placeBlock(reference, face) {
            assert.deepEqual(reference.position.plus(face), wall);
            placed.push(wall);
        },
        async lookAt(target) { aim = target; },
        setControlState(name, enabled) {
            if (name !== 'forward' || !enabled) return;
            assert.equal(this.time.timeOfDay, 6000);
            assert.ok(!this.entities[1]);
            const cell = [landing, base].find(p => p.x === Math.floor(aim.x));
            assert.ok(cell);
            landings.push(cell);
            this.entity.position = cell.offset(0.5,0,0.5);
        },
        pathfinder: { setGoal() {} }, clearControlStates() {},
    });
    const behavior = attachIdle(bot, {
        isIdle: () => true, isEnabled: () => true, setWalking() {}, greetings: { last: 0, players: new Map() },
        log(line) {
            if (line.startsWith('Sealed exposed spawn ledge side')) bot.emit('sealed');
            if (line.includes('waiting for daylight')) bot.emit('daylightHold');
            if (line.startsWith('Returned to saved jungle base')) bot.emit('returned');
        },
    });
    t.after(() => behavior.close());
    const goal = bot[Symbol.for('devincraft.diamond.goal')];
    goal.setSpawnRelocation({ origin: { ...start }, base: { ...base }, escape: { origin: { ...start }, destination: { ...base } } });
    await once(bot, 'sealed');
    assert.deepEqual(placed, [wall]);
    assert.deepEqual(bot.entity.position.floored(), start);
    assert.match(goal.status().blockers[0], /hostile within 12 blocks of landing/);
    bot.time.timeOfDay = 12000;
    delete bot.entities[1];
    await once(bot, 'daylightHold');
    assert.deepEqual(bot.entity.position.floored(), start);
    assert.deepEqual(landings, []);
    bot.time.timeOfDay = 6000;
    await once(bot, 'returned');
    assert.deepEqual(landings, [landing, base]);
});

for (const partial of [false, true]) test(`a persistent hostile landing is bypassed on a supported ${partial ? 'high ledge' : 'route to ground'}`, { timeout: 21_000 }, async t => {
    const start = new Vec3(0,67,0), unsafe = new Vec3(1,64,0);
    const exit = new Vec3(-1,partial ? 67 : 66,0), next = exit.offset(-1,0,0);
    const base = partial ? next.offset(-3,-1,0) : next;
    const enemy = { name: 'zombie', type: 'hostile', position: new Vec3(13,64,0.5) };
    const moves = [];
    let aim, held = false;
    const bot = Object.assign(new EventEmitter(), {
        registry: createRegistry('1.21.1'), entity: { position: start.offset(0.5,0,0.5), onGround: true },
        game: { gameMode: 'survival', dimension: 'overworld', minY: 0, height: 75 },
        time: { isDay: true, timeOfDay: 6000 },
        health: 20, food: 20, entities: { 1: enemy }, players: {}, inventory: { items: () => [] },
        blockAt(point) {
            const name = start.offset(0,-1,0).equals(point) ? 'mangrove_roots'
                : [unsafe, base].some(cell => cell.offset(0,-1,0).equals(point)) ? 'mud'
                : [exit, next].some(cell => cell.offset(0,-1,0).equals(point)) ? (partial ? 'mangrove_leaves' : 'mud') : 'air';
            return { position: point, name, boundingBox: name === 'air' ? 'empty' : 'block',
                getProperties: () => ({ persistent: false }) };
        },
        async lookAt(target) { aim = target; },
        setControlState(name, enabled) {
            if (name !== 'forward' || !enabled) return;
            const cell = [exit, next].find(p => p.x === Math.floor(aim.x));
            assert.ok(cell, 'the bot must not descend toward the hostile landing');
            assert.ok(held);
            moves.push(cell);
            this.entity.position = cell.offset(0.5,0,0.5);
            if (partial && cell.equals(next)) this.emit('advanced');
        },
        canDigBlock() { return true; },
        async dig() { assert.fail('the bypass does not need to dig'); },
        pathfinder: { setGoal() {} }, clearControlStates() {},
    });
    const behavior = attachIdle(bot, {
        isIdle: () => true, isEnabled: () => true, setWalking() {}, greetings: { last: 0, players: new Map() },
        log(line) {
            if (line.startsWith('Holding spawn ledge')) {
                assert.match(line, /above \(1, 64, 0\): hostile/);
                held = true;
                bot.emit('holding');
            }
            if (line.startsWith('Returned to saved jungle base')) bot.emit('returned');
        },
    });
    t.after(() => behavior.close());
    const goal = bot[Symbol.for('devincraft.diamond.goal')];
    goal.setSpawnRelocation({ origin: { ...start }, base: { ...base }, escape: { origin: { ...start }, destination: { ...base } } });
    await once(bot, 'holding');
    assert.deepEqual(bot.entity.position.floored(), start);
    await once(bot, partial ? 'advanced' : 'returned');
    assert.deepEqual(moves, [exit, next]);
    assert.equal(bot.entities[1], enemy);
});

test('saved-base return follows a longer dry detour when the base is close but the path bends away', { timeout: 11_000 }, async t => {
    const route = [[0,0],[0,1],[0,2],[0,3],[0,4],[0,5],[1,5],[2,5],[3,5],[3,4],[3,3],[3,2],[3,1],[3,0]]
        .map(([x,z]) => new Vec3(x,64,z));
    const start = route[0], base = route.at(-1), steps = [];
    let aim;
    const bot = Object.assign(new EventEmitter(), {
        registry: createRegistry('1.21.1'), entity: { position: start.offset(0.5,0,0.5), onGround: true },
        game: { gameMode: 'survival', dimension: 'overworld', minY: 0, height: 75 },
        health: 20, food: 20, entities: {}, players: {}, inventory: { items: () => [] },
        blockAt(point) {
            const name = route.some(cell => cell.offset(0,-1,0).equals(point)) ? 'grass_block' : 'air';
            return { position: point, name, boundingBox: name === 'air' ? 'empty' : 'block' };
        },
        async lookAt(target) { aim = target; },
        setControlState(name, enabled) {
            if (name !== 'forward' || !enabled) return;
            const cell = new Vec3(Math.floor(aim.x),64,Math.floor(aim.z));
            assert.ok(cell.equals(route[steps.length+1]));
            steps.push(cell);
            this.entity.position = cell.offset(0.5,0,0.5);
        },
        pathfinder: { setGoal() {} }, clearControlStates() {},
    });
    const behavior = attachIdle(bot, {
        isIdle: () => true, isEnabled: () => true, setWalking() {}, greetings: { last: 0, players: new Map() },
        log(line) { if (line.startsWith('Returned to saved jungle base')) bot.emit('returned'); },
    });
    t.after(() => behavior.close());
    const goal = bot[Symbol.for('devincraft.diamond.goal')];
    goal.setSpawnRelocation({ origin: { ...start }, base: { ...base }, escape: { origin: { ...start }, destination: { ...base } } });
    await once(bot, 'returned');
    assert.deepEqual(steps, route.slice(1));
});

test('two early deaths trigger a consistent ground-only route around leaves to a dry forest base', { timeout: 24_000 }, async t => {
    const start = new Vec3(0,64,0);
    const registry = createRegistry('1.21.1');
    const forest = registry.biomesByName.forest.id;
    const steps = [];
    let aim, killed = false;
    const bot = Object.assign(new EventEmitter(), {
        registry, entity: { position: start.offset(0.5,0,0.5), onGround: true },
        game: { gameMode: 'survival', dimension: 'overworld', minY: 0, height: 70 },
        health: 20, food: 20, entities: {}, players: {}, inventory: { items: () => [] },
        world: { getBiome: p => p.x >= 24 ? forest : registry.biomesByName.swamp.id },
        blockAt(p) {
            const corridor = p.x >= -10 && p.z >= 0 && p.z <= (p.x < 23 ? 1 : 2);
            const name = p.y === 63 && corridor ? (p.x === 1 && p.z === 0 ? 'oak_leaves' : 'grass_block') : 'air';
            return { position: p, name, boundingBox: name === 'air' ? 'empty' : 'block',
                getProperties: () => ({ persistent: false }) };
        },
        async lookAt(target) { aim = target; },
        setControlState(name, enabled) {
            if (name !== 'forward' || !enabled) return;
            const next = new Vec3(aim.x, start.y, aim.z);
            assert.equal(this.blockAt(next.floored().offset(0,-1,0)).name, 'grass_block');
            steps.push(next.floored());
            this.entity.position = next;
        },
        clearControlStates() {},
        pathfinder: { setGoal() {} },
    });
    const behavior = attachIdle(bot, {
        isIdle: () => true, isEnabled: () => true, setWalking() {}, greetings: { last: 0, players: new Map() },
        log(line) { if (line.startsWith('Dry surface base selected')) bot.emit('base'); },
    });
    t.after(() => behavior.close());
    const goal = bot[Symbol.for('devincraft.diamond.goal')];
    const selected = once(bot, 'base');
    const trigger = setInterval(() => {
        if (killed || !goal.spawnRelocation()) return;
        killed = true;
        bot.emit('death');
        bot.emit('death');
    }, 50);
    t.after(() => clearInterval(trigger));
    await selected;
    assert.equal(goal.status().deaths, 2);
    assert.deepEqual(goal.spawnRelocation().heading, [1,0]);
    assert.ok(steps[0].equals(start.offset(0,0,1)));
    assert.ok(steps.every((point, i) => i === 0 || point.x >= steps[i - 1].x));
    assert.ok(goal.spawnRelocation().base.x >= 24);
    assert.equal(goal.spawnRelocation().escape, null);
    assert.equal(goal.bed(), undefined);
});

test('spawn relocation never advances more than 150 blocks from its starting point', { timeout: 5000 }, async t => {
    const bot = Object.assign(new EventEmitter(), {
        entity: { position: new Vec3(149.5,64,0.5), onGround: true },
        game: { gameMode: 'survival', dimension: 'overworld', minY: 0, height: 68 },
        health: 20, food: 20, entities: {}, players: {}, inventory: { items: () => [] },
        blockAt: p => ({ position: p, name: p.y === 63 ? 'mud' : 'air', boundingBox: p.y === 63 ? 'block' : 'empty' }),
        async lookAt(target) { this.aim = target; },
        setControlState(name, enabled) {
            if (name === 'forward' && enabled) this.entity.position = new Vec3(this.aim.x,64,this.aim.z);
        },
        clearControlStates() {},
        pathfinder: { setGoal() {} },
    });
    const behavior = attachIdle(bot, {
        isIdle: () => true, isEnabled: () => true, setWalking() {}, log() {}, greetings: { last: 0, players: new Map() },
    });
    t.after(() => behavior.close());
    const goal = bot[Symbol.for('devincraft.diamond.goal')];
    const origin = { x: 0, y: 64, z: 0 };
    goal.setSpawnRelocation({ origin, escape: { origin, heading: [1,0] } });
    await new Promise(resolve => setTimeout(resolve, 1700));
    assert.equal(bot.entity.position.x, 150.5);
    assert.deepEqual(goal.status().blockers, ['No dry base found within the 150-block spawn escape']);
    assert.equal(goal.spawnRelocation().exhausted, true);
    assert.equal(goal.spawnRelocation().base, undefined);
});

test('three distinct early path stalls near spawn activate relocation without a death', { timeout: 22_000 }, async t => {
    const bot = Object.assign(new EventEmitter(), {
        entity: { position: new Vec3(0.5,64,0.5), onGround: true },
        game: { gameMode: 'survival', dimension: 'overworld', minY: 0, height: 68 },
        health: 20, food: 20, entities: {}, players: {}, inventory: { items: () => [] },
        blockAt: p => ({ position: p, name: p.y === 63 ? 'grass_block' : 'air', boundingBox: p.y === 63 ? 'block' : 'empty' }),
        async lookAt() {},
        setControlState() {},
        clearControlStates() {},
        pathfinder: { setGoal(goal) { this.goal = goal; } },
    });
    let stalls = 0;
    const behavior = attachIdle(bot, {
        isIdle: () => true, isEnabled: () => true, setWalking() {}, greetings: { last: 0, players: new Map() },
        log(line) {
            if (line.startsWith('Movement stalled: wander')) stalls++;
            if (line.startsWith('Leaving hazardous spawn')) bot.emit('relocating');
        },
    });
    t.after(() => behavior.close());
    await once(bot, 'relocating');
    assert.equal(stalls, 3);
    assert.equal(bot[Symbol.for('devincraft.diamond.goal')].status().deaths, 0);
});

test('a stalled mangrove log pickup walks directly across a clear floor', { timeout: 7500 }, async t => {
    const position = new Vec3(0.5,64,0.5);
    const drop = { id: 1, position: position.offset(2,0,0), getDroppedItem: () => ({ name: 'mangrove_log' }) };
    const items = [];
    const bot = Object.assign(new EventEmitter(), {
        game: { gameMode: 'survival' }, entity: { position }, entities: { 1: drop }, health: 20, food: 20,
        inventory: { items: () => items }, recipesFor: () => [],
        nearestEntity: test => bot.entities[1] && test(drop) ? drop : undefined,
        blockAt: p => p.y < 64 ? { name: 'mud', boundingBox: 'block' } : { name: 'air' },
        async lookAt() {},
        setControlState(key, value) {
            if (key !== 'forward' || !value) return;
            assert.equal(bot.pathfinder.goal, null);
            bot.entity.position = drop.position.clone();
            items.push(drop.getDroppedItem());
            delete bot.entities[1];
            bot.emit('pickup');
        },
        clearControlStates() {},
        pathfinder: { setGoal(goal) { this.goal = goal; } },
    });
    const behavior = attachIdle(bot, {
        isIdle: () => true, isEnabled: () => true, setWalking() {}, log() {}, greetings: { last: 0, players: new Map() },
    });
    t.after(() => behavior.close());
    await once(bot, 'pickup');
    assert.equal(behavior.status().type, 'collect_gear');
    assert.equal(items[0].name, 'mangrove_log');
});

test('wood gathering approaches a low trunk log from a flat adjacent cell before cutting', { timeout: 5000 }, async t => {
    const low = new Vec3(2,64,0), high = low.offset(0,2,0), stand = low.offset(-1,0,0);
    const bot = Object.assign(new EventEmitter(), {
        game: { gameMode: 'survival' }, entity: { position: new Vec3(0.5,64,0.5), onGround: true, eyeHeight: 1.65 },
        players: {}, health: 20, food: 20, inventory: { items: () => [] },
        recipesFor: () => [], findBlocks: () => [high, low],
        blockAt(p) {
            const name = p.y < 64 ? 'dirt'
                : p.x === 2 && p.z === 0 && p.y <= 66 ? 'jungle_log'
                : p.y === 67 && Math.abs(p.x - 2) <= 1 && Math.abs(p.z) <= 1 ? 'jungle_leaves' : 'air';
            return { name, position: p, diggable: true, boundingBox: name === 'air' ? 'empty' : 'block',
                getProperties: () => ({ axis: 'y', persistent: false }) };
        },
        world: { raycast(from, direction, length) { return bot.blockAt(from.plus(direction.scaled(length - 0.02)).floored()); } },
        canDigBlock: () => true, stopDigging() {}, clearControlStates() {},
        async dig(block) { this.emit('cut', block.position, this.entity.position.floored()); },
        pathfinder: { setGoal(goal) { if (goal) bot.emit('treeGoal', goal); } },
    });
    const behavior = attachIdle(bot, {
        isIdle: () => true, isEnabled: () => true, setWalking() {}, log() {}, greetings: { last: 0, players: new Map() },
    });
    t.after(() => behavior.close());
    const [goal] = await once(bot, 'treeGoal');
    assert.ok(goal.isEnd(stand));
    assert.equal(goal.isEnd(bot.entity.position.floored()), false);
    bot.entity.position = stand.offset(0.5,0,0.5);
    assert.deepEqual(await once(bot, 'cut'), [low, stand]);
});

for (const situation of ['safe drop', 'missing', 'cliff drop']) {
    const tableDropped = situation !== 'missing', canCollect = situation === 'safe drop';
    test(`a geared bot without its table ${canCollect ? 'recovers the dropped table across a stalled path'
        : situation === 'cliff drop' ? 'replaces a dropped table next to a cliff' : 'crafts a replacement table'}`,
        { timeout: 7500 }, async t => {
            const position = new Vec3(0.5,17,0.5);
            const drop = { id: 1, position: position.offset(2,0,0), getDroppedItem: () => ({ name: 'crafting_table', count: 1 }) };
            const items = ['stone_pickaxe', 'stone_sword', 'furnace'].map(name => ({ name, count: 1 }));
            items.push({ name: 'oak_planks', count: 4 }, { name: 'dirt', count: 16 });
            const bot = Object.assign(new EventEmitter(), {
                registry: createRegistry('1.21.1'), game: { gameMode: 'survival', dimension: 'overworld' },
                entity: { position, onGround: true }, entities: tableDropped ? { 1: drop } : {}, health: 20, food: 20,
                inventory: { items: () => items }, recipesFor: id => [{ id }],
                nearestEntity: predicate => Object.values(bot.entities).find(predicate),
                blockAt(point) {
                    const solid = point.y < (situation === 'cliff drop' && point.x === 3 ? 11 : 17);
                    return { position: point, name: solid ? 'cobblestone' : 'air', boundingBox: solid ? 'block' : 'empty' };
                },
                async craft(recipe) {
                    assert.equal(canCollect, false);
                    assert.equal(recipe.id, this.registry.itemsByName.crafting_table.id);
                    items.push(drop.getDroppedItem());
                    this.emit('hasTable');
                },
                async lookAt() {},
                setControlState(key, on) {
                    if (key !== 'forward' || !on) return;
                    assert.equal(canCollect, true);
                    assert.equal(this.pathfinder.goal, null);
                    this.entity.position = drop.position.clone();
                    items.push(drop.getDroppedItem());
                    delete this.entities[1];
                    this.emit('hasTable');
                },
                clearControlStates() {},
                pathfinder: { setGoal(goal) { this.goal = goal; } },
            });
            const behavior = attachIdle(bot, {
                isIdle: () => true, isEnabled: () => true, setWalking() {}, log() {},
                greetings: { last: 0, players: new Map() },
            });
            t.after(() => behavior.close());
            bot[Symbol.for('devincraft.diamond.goal')].station('crafting_table', drop.position.floored());
            await once(bot, 'hasTable');
            assert.ok(items.some(item => item.name === 'crafting_table'));
        });
}

test('bootstrap leaves inaccessible mangrove drops for the bounded forest search', { timeout: 16_000 }, async t => {
    const position = new Vec3(0.5,64,0.5);
    const drops = [5,-5].map((x, id) => ({ id, position: position.offset(x,4,0),
        getDroppedItem: () => ({ name: 'mangrove_log' }) }));
    const bot = Object.assign(new EventEmitter(), {
        game: { gameMode: 'survival' }, entity: { position }, entities: Object.fromEntries(drops.map(drop => [drop.id, drop])),
        health: 20, food: 20, registry: createRegistry('1.21.1'), inventory: { items: () => [] }, recipesFor: () => [],
        findBlocks: () => [], nearestEntity: predicate => drops.find(predicate),
        blockAt: p => p.y === 63 && ((!p.x && !p.z) || Math.abs(p.x) + Math.abs(p.z) >= 6)
            ? { name: 'dirt', boundingBox: 'block' } : { name: 'air' },
        clearControlStates() {}, pathfinder: { movements: {}, setGoal(goal) { this.goal = goal; } },
    });
    const behavior = attachIdle(bot, {
        isIdle: () => true, isEnabled: () => true, setWalking() {},
        log(line) { if (line.startsWith('Forest search: heading=')) bot.emit('forest'); },
        greetings: { last: 0, players: new Map() },
    });
    t.after(() => behavior.close());
    await once(bot, 'forest');
    assert.equal(behavior.status().type, 'seek_forest');
});

test('woodless bootstrap ascends for wood after an empty gear search', { timeout: 5000 }, async t => {
    await assertBootstrapAscent(t, []);
});

test('bootstrap ascends for a table with only one plank and no stone pickaxe', { timeout: 5000 }, async t => {
    const supplies = ['oak_planks', 'wooden_pickaxe', 'stone_sword', 'furnace', 'iron_ingot'].map(name => ({ name, count: 1 }));
    supplies.push({ name: 'cobblestone', count: 64 }, { name: 'stick', count: 2 });
    await assertBootstrapAscent(t, supplies);
});

test('wood resupply detours around a blocked ascent without revisiting its last cell', { timeout: 5000 }, async t => {
    await assertBootstrapAscent(t, [], true);
});

test('wood restock switches steps when pathfinder reports a pillar reached from one block below', { timeout: 5000 }, async t => {
    const origin = new Vec3(0,64,0);
    const bot = Object.assign(new EventEmitter(), {
        game: { gameMode: 'survival' }, entity: { position: origin.offset(0.5,0,0.5), onGround: true },
        health: 20, food: 20, players: {}, inventory: { items: () => [{ name: 'dirt', count: 16 }] },
        registry: createRegistry('1.21.1'), recipesFor: () => [], findBlocks: () => [],
        blockAt(point) {
            const name = point.y < 64 || point.y >= 70 ? 'stone' : 'air';
            return { name, position: point, boundingBox: name === 'air' ? 'empty' : 'block' };
        },
        clearControlStates() {},
        pathfinder: { movements: {}, setGoal(goal) { if (goal) bot.emit('ascent', goal); } },
    });
    const behavior = attachIdle(bot, {
        isIdle: () => true, isEnabled: () => true, setWalking() {}, log() {},
        greetings: { last: 0, players: new Map() },
    });
    t.after(() => behavior.close());
    const [pillar] = await once(bot, 'ascent');
    assert.deepEqual([pillar.x, pillar.y, pillar.z], [0,65,0]);
    bot.emit('goal_reached', pillar);
    const [detour] = await once(bot, 'ascent');
    assert.equal(behavior.status().type, 'walk_level_step');
    assert.deepEqual([detour.x, detour.y, detour.z], [1,64,0]);
});

for (const falling of [false, true]) {
    test(falling ? 'wood restock leaves a shaft with gravel overhead alone' : 'wood restock clears its headroom and pillars straight up', { timeout: 5000 }, async t => {
        const origin = new Vec3(0,64,0);
        const cobble = { name: 'cobblestone', count: 18 };
        const digs = [], placed = [];
        const roof = new Set([66,67]);
        const bot = Object.assign(new EventEmitter(), {
            game: { gameMode: 'survival', minY: 0, height: 80 },
            entity: { position: origin.offset(0.5,0,0.5), onGround: true },
            health: 20, food: 20, players: {}, inventory: { items: () => [cobble] },
            recipesFor: () => [], findBlocks: () => [],
            blockAt(point) {
                const shaft = point.x === 0 && point.z === 0;
                const name = placed.some(p => p.equals(point)) ? 'cobblestone'
                    : shaft && falling && point.y === 68 ? 'gravel'
                    : shaft && roof.has(point.y) ? 'stone'
                    : point.y < 64 || !shaft && point.y <= 66 ? 'bedrock' : 'air';
                return { name, position: point, boundingBox: name === 'air' ? 'empty' : 'block' };
            },
            world: { raycast(from, direction, distance) {
                return bot.blockAt(from.plus(direction.scaled(distance - 0.02)).floored());
            } },
            canDigBlock: block => block.name === 'stone',
            async dig(block) {
                assert.equal(block.position.x, 0);
                assert.equal(block.position.z, 0);
                digs.push(block.position.y);
                roof.delete(block.position.y);
            },
            stopDigging() {},
            async equip(item) { assert.equal(item, cobble); },
            async lookAt() {},
            async look(_yaw, pitch) { assert.equal(pitch, -Math.PI / 2); },
            setControlState(control, value) {
                if (control !== 'jump' || !value) return;
                assert.ok(this.entity.onGround);
                assert.equal(this.pathfinder.goal, null);
                this.entity.onGround = false;
                this.entity.position = this.entity.position.offset(0,1.2,0);
            },
            async placeBlock(anchor, face) {
                const point = anchor.position.plus(face);
                assert.ok(this.entity.position.y > point.y + 1);
                placed.push(point);
                this.entity.position = point.offset(0.5,1,0.5);
                this.entity.onGround = true;
                cobble.count--;
            },
            clearControlStates() {}, pathfinder: { movements: {}, setGoal(goal) { this.goal = goal; } },
        });
        const behavior = attachIdle(bot, {
            isIdle: () => true, isEnabled: () => true, setWalking() {},
            log(line) {
                if (line === 'Wood restock pillar: landed on (0, 66, 0)') bot.emit('rim');
            },
            greetings: { last: 0, players: new Map() },
        });
        t.after(() => behavior.close());
        if (falling) {
            await new Promise(resolve => setTimeout(resolve, 750));
            assert.deepEqual(digs, []);
            assert.deepEqual(placed, []);
        } else {
            await once(bot, 'rim');
            assert.deepEqual(digs, [66,67]);
            assert.deepEqual(placed, [origin, origin.offset(0,1,0)]);
            assert.equal(cobble.count, 16);
        }
    });
}

async function assertBootstrapAscent(t, supplies, blockedAscent = false) {
    const origin = new Vec3(0,64,0);
    const bot = Object.assign(new EventEmitter(), {
        game: { gameMode: 'survival' }, entity: { position: origin.offset(0.5,0,0.5), onGround: true },
        health: 20, food: 20, players: {}, inventory: { items: () => [{ name: 'dirt', count: 16 }, ...supplies] },
        recipesFor: () => [], findBlocks: () => [],
        blockAt(point) {
            const name = point.y <= 63 || point.y >= 70 || (!blockedAscent && point.equals(origin.offset(1,0,0)))
                ? 'stone' : blockedAscent && point.y === 66 ? 'bedrock' : 'air';
            return { name, position: point, boundingBox: name === 'air' ? 'empty' : 'block' };
        },
        clearControlStates() {},
        pathfinder: { movements: {}, setGoal(goal) { if (goal) bot.emit('ascent', goal); } },
    });
    const behavior = attachIdle(bot, {
        isIdle: () => true, isEnabled: () => true, setWalking() {}, log() {},
        greetings: { last: 0, players: new Map() },
    });
    t.after(() => behavior.close());
    const [goal] = await once(bot, 'ascent');
    assert.equal(behavior.status().type, blockedAscent ? 'walk_level_step' : 'walk_up_step');
    assert.deepEqual([goal.x, goal.y, goal.z], [1,blockedAscent ? 64 : 65,0]);
    if (blockedAscent) {
        bot.entity.position = origin.offset(1.5,0,0.5);
        bot.emit('goal_reached', goal);
        const [next] = await once(bot, 'ascent');
        assert.equal(behavior.status().type, 'walk_level_step');
        assert.deepEqual([next.x, next.y, next.z], [2,64,0]);
    }
}

test('an unreachable melee pursuer yields to the task, but closes with a fallback tool in melee range', { timeout: 7000 }, async t => {
    const position = new Vec3(0, 64, 0);
    const hostile = { id: 1, name: 'husk', type: 'hostile', position: position.offset(7, 0, 0) };
    const tool = { name: 'stone_pickaxe', count: 1 };
    const bot = Object.assign(new EventEmitter(), {
        game: { gameMode: 'survival' }, entity: { position }, entities: { 1: hostile }, players: {}, health: 20, food: 20,
        inventory: { items: () => [tool] },
        async equip(item) { this.heldItem = item; },
        async lookAt() {}, attack(target) { this.emit('swung', target); },
        setControlState(key, value) { if (key === 'back' && value) this.emit('retreat'); },
        clearControlStates() {},
        blockAt: p => p.y < 64 ? { name: 'stone', boundingBox: 'block' } : { name: 'air' },
        pathfinder: { setGoal(goal) { if (goal instanceof goals.GoalFollow) bot.emit('path_update', { status: 'noPath' }); } },
    });
    const lines = [];
    const behavior = attachIdle(bot, {
        isIdle: () => true, isEnabled: () => true, setWalking() {},
        log(line) {
            lines.push(line);
            if (line.includes('resuming task temporarily')) bot.emit('resume');
        },
        greetings: { last: 0, players: new Map() },
    });
    t.after(() => behavior.close());
    await once(bot, 'resume');
    assert.notEqual(behavior.status().type, 'fight');
    assert.ok(lines.some(line => line.includes('path=noPath range=7.0 moved=0.0 LOS=true')));
    hostile.position = position.offset(2, 0, 0);
    const [[target]] = await Promise.all([once(bot, 'swung'), once(bot, 'retreat')]);
    assert.equal(target, hostile);
    assert.equal(bot.heldItem, tool);
});

test('an unarmed bot crafts a wooden sword at a local table before reaching a single spider', { timeout: 5000 }, async t => {
    const position = new Vec3(0, 64, 0);
    const table = { name: 'crafting_table', position: position.offset(-2, 0, 0) };
    const hostile = { id: 1, name: 'spider', type: 'hostile', position: position.offset(7, 0, 0) };
    const items = [{ name: 'oak_planks', count: 10 }, { name: 'stick', count: 1 }];
    const bot = Object.assign(new EventEmitter(), {
        game: { gameMode: 'survival' }, registry: createRegistry('1.21.1'),
        entity: { position }, entities: { 1: hostile }, players: {}, health: 20, food: 20,
        inventory: { items: () => items },
        blockAt: point => point.equals(table.position) ? table : { name: 'air' },
        canDigBlock: () => false,
        world: { raycast: (_from, _dir, _distance, matcher) => matcher ? table : null },
        recipesFor: (id, _, _count, bench) => {
            assert.equal(id, bot.registry.itemsByName.wooden_sword.id);
            assert.equal(bench, table);
            return [{}];
        },
        async craft() { this.emit('crafted'); },
        pathfinder: { setGoal() {} }, clearControlStates() {},
    });
    const behavior = attachIdle(bot, {
        isIdle: () => true, isEnabled: () => true, setWalking() {}, log() {},
        greetings: { last: 0, players: new Map() },
    });
    t.after(() => behavior.close());
    bot[Symbol.for('devincraft.diamond.goal')].station('crafting_table', table.position);
    await once(bot, 'crafted');
});

test('gear bootstrap plans logs, planks, table, sticks, wooden tools, and stone upgrades', () => {
    const items = entries => entries.map(([name, count]) => ({ name, count }));
    const plan = (...entries) => gearPlan(items(entries));
    assert.deepEqual(plan(), { wood: true });
    assert.deepEqual(plan(['mangrove_log', 1]), { craft: 'mangrove_planks' });
    assert.deepEqual(plan(['mangrove_planks', 9]), { craft: 'crafting_table' });
    assert.deepEqual(plan(['crafting_table', 1], ['mangrove_planks', 5]), { craft: 'stick' });
    const supplies = [['crafting_table', 1], ['mangrove_planks', 5], ['stick', 4]];
    assert.deepEqual(plan(...supplies), { tool: 'wooden_pickaxe' });
    assert.deepEqual(plan(['crafting_table', 1], ['mangrove_planks', 3], ['stick', 2]), { tool: 'wooden_pickaxe' });
    assert.deepEqual(plan(...supplies, ['wooden_pickaxe', 1]), { tool: 'wooden_sword' });
    assert.deepEqual(plan(...supplies, ['wooden_pickaxe', 1], ['wooden_sword', 1]), { mine: true });
    assert.deepEqual(plan(...supplies, ['wooden_pickaxe', 1], ['wooden_sword', 1], ['cobblestone', 3]), { tool: 'stone_pickaxe' });
    assert.deepEqual(plan(...supplies, ['stone_pickaxe', 1], ['wooden_sword', 1], ['cobblestone', 2]), { tool: 'stone_sword' });
    assert.equal(plan(['stone_pickaxe', 1], ['stone_sword', 1]), null);
    assert.deepEqual(gearPlan(items([['crafting_table', 1], ['stone_pickaxe', 1], ['stone_sword', 1], ['cobblestone', 8]]),
        { furnaceReady: false }), { tool: 'furnace' });
});

test('diamond goal advances through six ordered stages and counts crafted gear', () => {
    const items = [];
    const context = { alive: true, safe: false, food: 20, station: true, furnace: true, safeFood: name => name === 'cooked_beef' };
    const add = (name, count = 1) => items.push({ name, count });
    const state = () => assess(items, context);
    assert.equal(state().stage, 1);
    context.safe = true;
    assert.equal(state().stage, 2);
    for (const name of ['mangrove_planks', 'cooked_beef', 'stone_pickaxe', 'stone_sword']) add(name);
    assert.equal(state().stage, 3);
    add('raw_iron', 3);
    assert.equal(state().stage, 4);
    add('iron_pickaxe');
    assert.equal(state().stage, 4);
    assert.equal(state().armorNeeded, 'iron_helmet');
    add('iron_helmet');
    assert.equal(state().stage, 4);
    assert.equal(state().armorNeeded, 'iron_chestplate');
    add('iron_chestplate');
    assert.equal(state().stage, 5);
    add('diamond', 26);
    add('diamond_pickaxe');
    assert.equal(state().stage, 6);
    assert.equal(state().diamonds.needed, 0);
    items.splice(items.findIndex(i => i.name === 'diamond'), 1);
    for (const name of Object.keys(diamondKit).filter(name => name !== 'diamond_pickaxe')) add(name);
    assert.equal(state().complete, true);
    assert.equal(state().diamonds.collected, 29);
});

test('stage four selects affordable helmet, then chestplate, only after an iron pickaxe', () => {
    const items = ['mangrove_planks', 'stone_pickaxe', 'stone_sword'].map(name => ({ name, count: 1 }));
    items.push({ name: 'iron_ingot', count: 3 }, { name: 'raw_iron', count: 5 });
    const state = () => assess(items, { alive: true, safe: true, food: 20, station: true, furnace: true });
    assert.equal(state().spareArmor, null);
    items.push({ name: 'iron_pickaxe', count: 1 });
    assert.equal(state().stage, 4);
    assert.equal(state().spareArmor, 'iron_helmet');
    items.push({ name: 'iron_helmet', count: 1 });
    assert.equal(state().spareArmor, 'iron_chestplate');
});

test('diamond descent rejects a staircase block adjacent to lava and never digs below the bot', () => {
    const origin = new Vec3(0, -55, 0);
    let lava = false;
    const blockAt = position => {
        const name = lava && position.equals(origin.offset(2,0,0)) ? 'lava' : position.y < origin.y + 1 ? 'deepslate' : 'air';
        return { position, name, boundingBox: name === 'deepslate' ? 'block' : 'empty' };
    };
    const bot = { entity: { position: origin }, blockAt, canDigBlock: () => true, canSeeBlock: () => true };
    const stair = tunnelPlan(bot, -58);
    assert.deepEqual(stair.point, origin.offset(1,-1,0));
    assert.deepEqual(stair.block.position, origin.offset(1,0,0));
    lava = true;
    assert.equal(canMine(bot, stair.block), false);
    assert.notEqual(tunnelPlan(bot, -58).point.x, 1);
});

test('staircase clears moss carpet and dry mangrove roots but rejects waterlogged roots', () => {
    const origin = new Vec3(0, 73, 0);
    const step = origin.offset(1, -1, 0);
    const carpet = step.offset(0, 2, 0);
    let clearCarpet = false, wet = false;
    const bot = {
        entity: { position: origin }, canDigBlock: () => true, canSeeBlock: () => true,
        blockAt(position) {
            const name = position.equals(carpet) && !clearCarpet ? 'moss_carpet'
                : position.x === 1 && position.z === 0 && position.y <= origin.y ? 'mangrove_roots' : 'air';
            return { position, name, boundingBox: name === 'air' ? 'empty' : 'block',
                getProperties: () => ({ waterlogged: wet && position.equals(step) }) };
        },
    };
    assert.deepEqual(tunnelPlan(bot, 72).block.position, carpet);
    clearCarpet = true;
    assert.deepEqual(tunnelPlan(bot, 72).block.position, step.offset(0, 1, 0));
    wet = true;
    assert.equal(tunnelPlan(bot, 72), undefined);
    assert.equal(canMine(bot, bot.blockAt(step)), false);
});

test('stone bootstrap leaves the roots for a dry staircase entrance rather than targeting a wet one', { timeout: 5000 }, async t => {
    const origin = new Vec3(0, 66, 0);
    const wetSite = origin.offset(2,-2,0);
    const drySite = origin.offset(4,-2,0);
    const items = ['wooden_pickaxe', 'wooden_sword', 'crafting_table', 'mangrove_log'].map(name => ({ name, count: 1 }));
    const bot = Object.assign(new EventEmitter(), {
        username: 'devincraftbot', registry: createRegistry('1.21.1'), game: { gameMode: 'survival', dimension: 'overworld' },
        health: 20, food: 20, entity: { position: origin.offset(0.5,0,0.5), onGround: true }, players: {}, entities: {},
        recipesFor: () => [], inventory: { items: () => items }, findBlocks: () => [],
        blockAt(position) {
            const name = position.equals(origin.offset(0,-1,0)) ? 'mangrove_roots'
                : [wetSite, drySite].some(site => position.equals(site.offset(0,-1,0)) || position.equals(site.offset(0,-2,1))) ? 'dirt'
                    : position.equals(wetSite.offset(0,-1,2)) ? 'water' : 'air';
            return { name, position, boundingBox: ['dirt', 'mangrove_roots'].includes(name) ? 'block' : 'empty' };
        },
        pathfinder: { movements: {}, setGoal(goal) { if (goal) bot.emit('entrance', goal); } }, clearControlStates() {},
    });
    const behavior = attachIdle(bot, {
        isIdle: () => true, isEnabled: () => true, setWalking() {}, log() {}, greetings: { last: 0, players: new Map() },
    });
    t.after(() => behavior.close());
    const [goal] = await once(bot, 'entrance');
    assert.equal(behavior.status().type, 'seek_stone_entrance');
    assert.ok(goal.isEnd(drySite));
    assert.equal(goal.isEnd(wetSite), false);
});

test('stone bootstrap descends a continuous vine column when the canopy has no staircase', { timeout: 5000 }, async t => {
    const origin = new Vec3(0,89,0);
    const entry = origin.offset(0,0,-1);
    const end = entry.offset(0,-18,0);
    const items = ['wooden_pickaxe', 'wooden_sword', 'crafting_table', 'jungle_log'].map(name => ({ name, count: 1 }));
    let aim;
    const bot = Object.assign(new EventEmitter(), {
        username: 'devincraftbot', registry: createRegistry('1.21.1'), game: { gameMode: 'survival', dimension: 'overworld' },
        health: 20, food: 20, entity: { position: origin.offset(0.5,0,0.5), onGround: true }, players: {}, entities: {},
        recipesFor: () => [], inventory: { items: () => items }, findBlocks: () => [],
        blockAt(position) {
            const name = position.equals(origin.offset(0,-1,0)) ? 'jungle_leaves'
                : position.y < end.y ? 'dirt'
                    : position.x === entry.x && position.z === entry.z && position.y <= entry.y && position.y >= end.y ? 'vine' : 'air';
            return { name, position, boundingBox: name === 'air' || name === 'vine' ? 'empty' : 'block',
                getProperties: () => ({ persistent: false }) };
        },
        async lookAt(point) { aim = point; },
        setControlState(control, value) {
            assert.equal(control, 'forward');
            if (value) {
                assert.equal(aim.x, entry.x + 0.5);
                assert.equal(aim.z, entry.z + 0.5);
                this.entity.position = entry.offset(0.5,0,0.5);
            } else if (this.entity.position.y !== end.y) {
                this.entity.position = end.offset(0.5,0,0.5);
                this.emit('landed');
            }
        },
        pathfinder: { movements: {}, setGoal: goal => assert.equal(goal, null) }, clearControlStates() {},
    });
    const behavior = attachIdle(bot, {
        isIdle: () => true, isEnabled: () => true, setWalking() {}, log() {}, greetings: { last: 0, players: new Map() },
    });
    t.after(() => behavior.close());
    await once(bot, 'landed');
    assert.equal(behavior.status().type, 'descend_vines');
    assert.equal(bot.entity.position.y, end.y);
});

test('woodless canopy bootstrap directly jumps to vines and lands on lower leaves', { timeout: 5000 }, async t => {
    const origin = new Vec3(0,89,0);
    const approach = origin.offset(1,1,0);
    const entry = approach.offset(1,0,0);
    const end = entry.offset(0,-5,0);
    let jumping = true;
    const bot = Object.assign(new EventEmitter(), {
        game: { gameMode: 'survival' },
        health: 20, food: 20, entity: { position: origin.offset(0.5,0,0.5), onGround: true },
        players: {}, entities: {}, recipesFor: () => [], inventory: { items: () => [] },
        findBlocks: () => [], canDigBlock: () => false, world: {},
        blockAt(position) {
            const leaf = [origin, approach, end].some(point => position.equals(point.offset(0,-1,0)));
            const vine = position.x === entry.x && position.z === entry.z && position.y <= entry.y && position.y >= end.y;
            return { name: leaf ? 'jungle_leaves' : vine ? 'vine' : 'air', position,
                boundingBox: leaf ? 'block' : 'empty', getProperties: () => ({ persistent: false }) };
        },
        async lookAt(aim) {
            const target = jumping ? approach : entry;
            assert.equal(aim.x, target.x + 0.5);
            assert.equal(aim.z, target.z + 0.5);
        },
        setControlState(control, enabled) {
            if (jumping) {
                if (control === 'jump' && enabled) {
                    this.entity.onGround = false;
                    this.entity.position = origin.offset(0.5,1.1,0.5);
                } else if (control === 'forward' && enabled) {
                    assert.ok(this.entity.position.y >= approach.y);
                    this.entity.position = approach.offset(0.5,0,0.5);
                    this.entity.onGround = true;
                    jumping = false;
                }
                return;
            }
            assert.equal(control, 'forward');
            if (enabled) this.entity.position = entry.offset(0.5,0,0.5);
            else {
                this.entity.position = end.offset(0.5,0,0.5);
                this.emit('landed');
            }
        },
        pathfinder: { movements: {}, setGoal(goal) { assert.equal(goal, null); } },
        clearControlStates() {},
    });
    const behavior = attachIdle(bot, {
        isIdle: () => true, isEnabled: () => true, setWalking() {}, log() {}, greetings: { last: 0, players: new Map() },
    });
    t.after(() => behavior.close());
    await once(bot, 'landed');
    assert.equal(behavior.status().type, 'descend_vines');
    assert.ok(bot.entity.position.floored().equals(end));
});

test('two stalled vine routes give way to an accessible tree without trying a third route', { timeout: 15000 }, async t => {
    const origin = new Vec3(0,89,0);
    const approaches = [origin.offset(3,0,0), origin.offset(-3,0,0), origin.offset(0,0,4)];
    const entries = approaches.map(point => point.offset(0,0,1));
    const log = origin.offset(0,1,-2);
    const canopy = [log.offset(0,1,-1), log.offset(1,1,-1), log.offset(-1,1,-1)];
    const routes = [];
    const bot = Object.assign(new EventEmitter(), {
        game: { gameMode: 'survival' },
        health: 20, food: 20, entity: { position: origin.offset(0.5,0,0.5), onGround: true },
        players: {}, entities: {}, recipesFor: () => [], inventory: { items: () => [] },
        world: { raycast: () => bot.blockAt(log) },
        findBlocks: ({ matching }) => matching(bot.blockAt(log)) ? [log] : [],
        canDigBlock: block => block.name === 'jungle_log',
        canSeeBlock: () => true,
        blockAt(position) {
            const leaf = canopy.some(point => position.equals(point))
                || [origin, origin.offset(1,0,0), ...approaches, ...entries.map(point => point.offset(0,-5,0))]
                .some(point => position.equals(point.offset(0,-1,0)));
            const vine = entries.some(entry => position.x === entry.x && position.z === entry.z
                && position.y <= entry.y && position.y >= entry.y - 5);
            const name = position.equals(log) ? 'jungle_log' : leaf ? 'jungle_leaves' : vine ? 'vine' : 'air';
            return { name, position, boundingBox: leaf || name === 'jungle_log' ? 'block' : 'empty', diggable: true,
                getProperties: () => ({ persistent: false }) };
        },
        async lookAt() { assert.fail('no direct movement is available'); },
        setControlState() {},
        pathfinder: { movements: {}, setGoal(goal) { this.goal = goal; } },
        clearControlStates() {},
    });
    const behavior = attachIdle(bot, {
        isIdle: () => true, isEnabled: () => true, setWalking() {}, greetings: { last: 0, players: new Map() },
        log(line) {
            if (line.startsWith('Idle behavior: seek_vine_descent')) routes.push(line);
            if (routes.length === 1 && line.startsWith('Movement stalled: seek_vine_descent'))
                bot.entity.position = origin.offset(1.5,0,0.5);
            if (line.startsWith('Idle behavior: gather_gear')) bot.emit('tree');
        },
    });
    t.after(() => behavior.close());
    await once(bot, 'tree');
    assert.equal(routes.length, 2);
    assert.notEqual(routes[0], routes[1]);
    assert.deepEqual(behavior.status().target, { x: log.x, y: log.y, z: log.z });
});

test('diamond descent scaffolds a dry missing step before walking onto it', () => {
    const origin = new Vec3(0, 30, 0);
    const step = origin.offset(1, -1, 0);
    const support = step.offset(0, -2, 0);
    let wet = false;
    const bot = {
        entity: { position: origin }, canDigBlock: () => true, canSeeBlock: () => true,
        blockAt(position) {
            const name = position.equals(support) ? 'stone' : wet && position.equals(step.offset(1,-1,0)) ? 'water' : 'air';
            return { position, name, boundingBox: name === 'stone' ? 'block' : 'empty' };
        },
    };
    assert.equal(tunnelPlan(bot, -58), undefined);
    const plan = tunnelPlan(bot, -58, null, undefined, undefined, true);
    assert.deepEqual(plan.point, step);
    assert.deepEqual(plan.scaffold.reference.position, support);
    assert.deepEqual(plan.scaffold.face, new Vec3(0,1,0));
    wet = true;
    assert.equal(tunnelPlan(bot, -58, null, undefined, undefined, true), undefined);
});

test('staircase seals water with cobble only after it and a solid anchor are visible', () => {
    const origin = new Vec3(0, 30, 0);
    const pool = origin.offset(1,-1,0);
    const anchor = pool.offset(1,0,0);
    const cover = pool.offset(0,1,0);
    let cleared = false;
    const bot = {
        entity: { position: origin }, canDigBlock: () => true,
        blockAt(position) {
            const name = position.equals(pool) ? 'water'
                : position.equals(anchor) || !cleared && position.equals(cover) ? 'stone' : 'air';
            return { name, position, boundingBox: name === 'stone' ? 'block' : 'empty' };
        },
    };
    const visible = b => !b.position.equals(pool) || cleared;
    assert.equal(tunnelPlan(bot, -58, null, visible, undefined, true), undefined);
    cleared = true;
    const { scaffold } = tunnelPlan(bot, -58, null, visible, undefined, true);
    assert.equal(scaffold.seal, 'water');
    assert.deepEqual(scaffold.reference.position.plus(scaffold.face), pool);
    assert.equal(tunnelPlan(bot, -58, null, visible, undefined, false), undefined);
});

test('iron staircase tunnels five dry blocks at level before descending again, without pathfinder', { timeout: 10_000 }, async t => {
    const origin = new Vec3(0, 30, 0);
    const items = ['stone_pickaxe', 'stone_sword', 'crafting_table', 'furnace'].map(name => ({ name, count: 1 }));
    items.push({ name: 'oak_planks', count: 8 }, { name: 'stick', count: 16 }, { name: 'oak_log', count: 3 });
    const dug = new Set(), walked = [];
    let aim;
    const bot = Object.assign(new EventEmitter(), {
        username: 'devincraftbot', registry: createRegistry('1.21.1'), game: { gameMode: 'survival', dimension: 'overworld' },
        health: 20, food: 20, entity: { position: origin.offset(0.5,0,0.5), onGround: true }, players: {}, entities: {},
        recipesFor: () => [], inventory: { items: () => items }, findBlocks: () => [],
        blockAt(position) {
            const name = dug.has(position.toString()) ? 'air'
                : position.y === 28 && position.x < 6 ? 'water'
                    : position.y <= 29 || position.x === 1 && position.z === 0 && position.y <= 31 ? 'stone' : 'air';
            return { name, position, diggable: name === 'stone', boundingBox: name === 'stone' ? 'block' : 'empty' };
        },
        world: { raycast(from, dir, distance) {
            return bot.blockAt(from.plus(dir.scaled(distance - 0.02)).floored());
        } },
        canDigBlock: b => b.diggable,
        async equip() {},
        async dig(block) { dug.add(block.position.toString()); },
        async lookAt(point) { aim = point; },
        setControlState(key, on) {
            if (key !== 'forward' || !on) return;
            const point = new Vec3(aim.x, aim.x >= 6.5 ? 29 : 30, aim.z);
            bot.entity.position = point;
            walked.push(point.floored());
            if (point.y === 29) bot.emit('resumed');
        },
        clearControlStates() {}, pathfinder: { setGoal(goal) { assert.equal(goal, null); } },
    });
    const behavior = attachIdle(bot, {
        isIdle: () => true, isEnabled: () => true, setWalking() {}, log() {}, greetings: { last: 0, players: new Map() },
    });
    t.after(() => behavior.close());
    await once(bot, 'resumed');
    assert.deepEqual(walked, [1,2,3,4,5].map(x => origin.offset(x,0,0)).concat(origin.offset(6,-1,0)));
    assert.ok(dug.has(origin.offset(1,1,0).toString()));
    assert.ok(dug.has(origin.offset(1,0,0).toString()));
});

test('diamond descent clears dry dripstone blocks but not pointed dripstone', () => {
    const origin = new Vec3(0,-9,0);
    const step = origin.offset(1,-1,0);
    const roof = step.offset(0,2,0);
    let pointed = false;
    const bot = {
        entity: { position: origin }, canDigBlock: () => true, canSeeBlock: () => true,
        blockAt(position) {
            const name = pointed && position.equals(roof) ? 'pointed_dripstone'
                : position.x === 1 ? 'dripstone_block' : 'air';
            return { position, name, boundingBox: name === 'air' ? 'empty' : 'block' };
        },
    };
    assert.deepEqual(tunnelPlan(bot, -58).point, step);
    assert.equal(tunnelPlan(bot, -58).block.name, 'dripstone_block');
    pointed = true;
    assert.equal(tunnelPlan(bot, -58), undefined);
});

test('branch mining turns after three spine cells and resumes the spine after returning', () => {
    const bot = {
        entity: { position: new Vec3(0,-58,0) },
        blockAt(position) {
            const empty = position.y >= -58;
            return { position, name: empty ? 'air' : 'deepslate', boundingBox: empty ? 'empty' : 'block' };
        },
    };
    let route;
    const move = () => {
        const plan = tunnelPlan(bot, -58, route);
        route = plan.route;
        bot.entity.position = plan.point;
        return plan.point;
    };
    for (let x = 1; x <= 3; x++) assert.deepEqual(move(), new Vec3(x,-58,0));
    for (let z = 1; z <= 12; z++) assert.deepEqual(move(), new Vec3(3,-58,z));
    assert.deepEqual(move(), new Vec3(3,-58,0));
    assert.deepEqual(move(), new Vec3(4,-58,0));
});

test('a stalled level iron tunnel turns and keeps the new heading', { timeout: 8000 }, async t => {
    const origin = new Vec3(0,16,0);
    const items = ['stone_pickaxe', 'stone_sword', 'crafting_table', 'furnace'].map(name => ({ name, count: 1 }));
    items.push({ name: 'stick', count: 16 }, { name: 'oak_log', count: 3 }, { name: 'dirt', count: 16 });
    const tried = [];
    const bot = Object.assign(new EventEmitter(), {
        game: { gameMode: 'survival', dimension: 'overworld' },
        health: 20, food: 20, entity: { position: origin.offset(0.5,0,0.5), onGround: true },
        recipesFor: () => [], inventory: { items: () => items }, findBlocks: () => [],
        blockAt(position) {
            const solid = position.y < origin.y;
            return { name: solid ? 'stone' : 'air', position, boundingBox: solid ? 'block' : 'empty' };
        },
        clearControlStates() {},
        pathfinder: { movements: {}, setGoal(goal) {
            this.goal = goal;
            if (!goal) return;
            const target = new Vec3(goal.x, goal.y, goal.z);
            tried.push(target);
            if (tried.length === 1) return;
            queueMicrotask(() => {
                bot.entity.position = target.offset(0.5,0,0.5);
                bot.emit('goal_reached', goal);
                if (tried.length === 3) bot.emit('turned');
            });
        } },
    });
    const behavior = attachIdle(bot, {
        isIdle: () => true, isEnabled: () => true, setWalking() {}, log() {},
        greetings: { last: 0, players: new Map() },
    });
    t.after(() => behavior.close());
    await once(bot, 'turned');
    assert.deepEqual(tried, [origin.offset(1,0,0), origin.offset(0,0,1), origin.offset(0,0,2)]);
});

test('level iron tunneling waits for falling gravel to settle and clears it before walking', { timeout: 7000 }, async t => {
    const origin = new Vec3(0,16,0);
    const next = origin.offset(1,0,0);
    const head = next.offset(0,1,0);
    const items = ['stone_pickaxe', 'stone_sword', 'crafting_table', 'furnace'].map(name => ({ name, count: 1 }));
    items.push({ name: 'stick', count: 2 }, { name: 'dirt', count: 16 }, { name: 'oak_log', count: 1 });
    const dug = [];
    let gravel = head;
    const bot = Object.assign(new EventEmitter(), {
        game: { gameMode: 'survival', dimension: 'overworld' },
        health: 20, food: 20, entity: { position: origin.offset(0.5,0,0.5), onGround: true },
        recipesFor: () => [], inventory: { items: () => items }, findBlocks: () => [],
        blockAt(position) {
            const name = position.y < origin.y ? 'stone' : gravel?.equals(position) ? 'gravel' : 'air';
            return { name, position, boundingBox: name === 'air' ? 'empty' : 'block' };
        },
        world: { raycast: (from, direction, distance) => bot.blockAt(from.plus(direction.scaled(distance - 0.02)).floored()) },
        canDigBlock: () => true, async equip() {}, stopDigging() {},
        async dig(block) {
            dug.push(block.position);
            gravel = undefined;
            if (dug.length === 1) {
                const refill = setTimeout(() => { gravel = next; }, 650);
                t.after(() => clearTimeout(refill));
            }
        },
        clearControlStates() {},
        pathfinder: { movements: {}, setGoal(goal) { if (goal) bot.emit('walking', goal); } },
    });
    const behavior = attachIdle(bot, {
        isIdle: () => true, isEnabled: () => true, setWalking() {}, log() {},
        greetings: { last: 0, players: new Map() },
    });
    t.after(() => behavior.close());
    const [goal] = await once(bot, 'walking');
    assert.deepEqual(dug, [head, next]);
    assert.deepEqual(new Vec3(goal.x, goal.y, goal.z), next);
});

async function staircaseFood(t, hunger, haveFood, stockUp = false) {
    const start = new Vec3(0, 64, 0);
    const step = start.offset(0,-1,1);
    const items = ['iron_pickaxe', 'stone_sword', 'crafting_table', 'furnace'].map(name => ({ name, count: 1 }));
    items.push({ name: 'iron_helmet', count: 1 }, { name: 'iron_chestplate', count: 1 });
    if (haveFood) items.push({ name: 'apple', count: 1 });
    const planks = { name: 'oak_planks', count: stockUp ? 6 : 8 };
    const sticks = { name: 'stick', count: stockUp ? 6 : 16 };
    const cobble = { name: 'cobblestone', count: 32 };
    items.push(planks, sticks, cobble);
    items.push({ name: 'oak_log', count: 3 });
    if (!stockUp) items.push({ name: 'stone_pickaxe', count: 1 });
    const actions = [];
    let table, packed = false;
    const drop = { position: start.offset(-0.5,0,0.5), getDroppedItem: () => ({ name: 'cobblestone' }) };
    const bot = Object.assign(new EventEmitter(), {
        username: 'devincraftbot', registry: createRegistry('1.21.1'), game: { gameMode: 'survival', dimension: 'overworld' },
        health: 20, food: hunger, entity: { position: start.offset(0.5,0,0.5), onGround: true }, players: {}, entities: {},
        recipesFor: id => stockUp ? [{ name: bot.registry.items[id].name }] : [], inventory: { items: () => items },
        blockAt(position) {
            const name = table?.equals(position) ? 'crafting_table' : stockUp && !packed && position.y === start.y - 1 ? 'stone'
                : position.equals(start.offset(1,-1,0)) ? 'lava'
                : position.y <= start.y - 2 || position.equals(start.offset(0,-1,0)) ? 'stone' : 'air';
            return { name, position, boundingBox: ['stone', 'crafting_table'].includes(name) ? 'block' : 'empty' };
        },
        findBlock: () => null, findBlocks: () => [],
        nearestEntity: predicate => stockUp && cobble.count === 32 && !items.some(i => i.name === 'stone_pickaxe') && predicate(drop) ? drop : null,
        async equip() {},
        async consume() { actions.push('eat'); items.splice(items.findIndex(i => i.name === 'apple'), 1); bot.food = 16; },
        async lookAt(point) { assert.equal(point.x, step.x + 0.5); assert.equal(point.z, step.z + 0.5); },
        setControlState(control, value) {
            if (control !== 'forward') return;
            if (value) {
                bot.entity.onGround = false;
                bot.entity.position = step.offset(0.5,0.6,0.5);
            } else {
                actions.push('step');
                bot.entity.onGround = true;
                bot.entity.position = step.offset(0.5,0,0.5);
                bot.emit('stepped');
            }
        },
        pathfinder: { setGoal(goal) { assert.equal(goal, null); } }, clearControlStates() {},
    });
    if (stockUp) Object.assign(bot, {
        world: { raycast: (from, direction, distance) => bot.blockAt(from.plus(direction.scaled(distance - 0.02)).floored()) },
        canDigBlock: () => true,
        async placeBlock(reference, face) {
            items.splice(items.findIndex(i => i.name === 'crafting_table'), 1);
            table = reference.position.plus(face);
        },
        async dig(block) {
            assert.equal(block.name, 'crafting_table');
            items.push({ name: 'crafting_table', count: 1 });
            table = undefined;
            packed = true;
        },
        async craft(recipe, _count, workbench) {
            actions.push(recipe.name);
            if (recipe.name === 'stick') {
                planks.count -= 2;
                sticks.count += 4;
            } else {
                assert.equal(recipe.name, 'stone_pickaxe');
                assert.equal(workbench.name, 'crafting_table');
                cobble.count -= 3;
                sticks.count -= 2;
                items.push({ name: recipe.name, count: 1 });
            }
        },
    });
    const behavior = attachIdle(bot, {
        isIdle: () => true, isEnabled: () => true, setWalking() {},
        log(line) {
            if (stockUp && line.startsWith('Idle behavior: collect_gear') && !items.some(i => i.name === 'stone_pickaxe')) {
                queueMicrotask(() => { actions.push('collect cobble'); cobble.count += 3; });
            }
        },
        greetings: { last: 0, players: new Map() },
    });
    t.after(() => behavior.close());
    await once(bot, 'stepped');
    assert.deepEqual(actions, stockUp ? ['stick', 'stick', 'stick', 'collect cobble', 'stone_pickaxe', 'step'] : haveFood ? ['eat', 'step'] : ['step']);
    assert.equal(bot.entity.position.y, 63);
    if (stockUp) {
        assert.equal(sticks.count, 16);
        assert.equal(cobble.count, 32);
        assert.equal(items.find(i => i.name === 'oak_log').count, 3);
        assert.ok(items.some(i => i.name === 'stone_pickaxe'));
        assert.ok(items.some(i => i.name === 'crafting_table'));
    }
}

test('staircase eats at hunger 6, avoids a wet column, and walks down without a pathfinder goal', { timeout: 8000 }, t => {
    return staircaseFood(t, 6, true);
});

test('staircase descends at hunger 11 without a food reserve', { timeout: 5000 }, t => {
    return staircaseFood(t, 11, false);
});

test('staircase eats carried food at hunger 14 without requiring a resupply trip', { timeout: 5000 }, t => {
    return staircaseFood(t, 14, true);
});

test('deep staircase stocks sticks, cobble, and a spare pickaxe before moving down', { timeout: 8000 }, t => {
    return staircaseFood(t, 20, false, true);
});

test('iron search stocks 16 sticks before departing the surface', { timeout: 5000 }, async t => {
    const items = ['stone_pickaxe', 'stone_sword', 'crafting_table', 'furnace'].map(name => ({ name, count: 1 }));
    items.push({ name: 'oak_log', count: 3 }, { name: 'oak_planks', count: 2 }, { name: 'stick', count: 12 });
    const bot = Object.assign(new EventEmitter(), {
        registry: createRegistry('1.21.1'), game: { gameMode: 'survival', minY: 0, height: 70 },
        entity: { position: new Vec3(0.5,64,0.5) }, players: {}, entities: {}, health: 20, food: 20,
        inventory: { items: () => items }, findBlocks: () => [], recipesFor: id => [{ name: bot.registry.items[id].name }],
        async craft(recipe) { bot.emit('crafted', recipe.name); },
        blockAt: position => ({ position, name: position.y < 64 ? 'stone' : 'air',
            boundingBox: position.y < 64 ? 'block' : 'empty' }),
        pathfinder: { setGoal: goal => assert.equal(goal, null) }, clearControlStates() {},
        lookAt: () => assert.fail('Descended without the surface reserve'),
    });
    const behavior = attachIdle(bot, {
        isIdle: () => true, isEnabled: () => true, setWalking() {}, log() {}, greetings: { last: 0, players: new Map() },
    });
    t.after(() => behavior.close());
    assert.deepEqual(await once(bot, 'crafted'), ['stick']);
});

test('diamond progress does not require the placed crafting table to be within reach for iron mining', () => {
    const items = ['stone_pickaxe', 'stone_sword', 'oak_planks', 'cooked_beef', 'furnace'].map(name => ({ name, count: 1 }));
    let remembered = { name: 'crafting_table' };
    const bot = Object.assign(new EventEmitter(), {
        inventory: { items: () => items }, entity: { position: new Vec3(0, 40, 0) },
        health: 20, food: 20, game: { dimension: 'overworld' }, blockAt: () => remembered,
    });
    const goal = attachDiamond(bot, (_bot, name) => name === 'cooked_beef');
    goal.station('crafting_table', new Vec3(0, 70, 0));
    assert.equal(goal.snapshot().stage, 3);
    remembered = { name: 'air' };
    assert.equal(goal.snapshot().stage, 2);
    goal.close();
});

test('staircase movement allows a one-block step down but not a two-block drop', () => {
    const registry = createRegistry('1.21.1');
    const Block = createBlock(registry);
    const bot = { registry, game: { minY: -64 }, entities: {},
        blockAt(point) {
            const floor = point.x === 1 ? 62 : point.x === -1 ? 61 : 63;
            const type = registry.blocksByName[point.y <= floor ? 'stone' : 'air'].id;
            const block = new Block(type, 0, 0);
            block.position = point;
            return block;
        },
        pathfinder: { setGoal(goal) { this.goal = goal; } },
    };
    const movement = new Movements(bot);
    Object.assign(movement, { maxDropDown: 1, canDig: false, allowParkour: false, allow1by1towers: false });
    const origin = Object.assign(new Vec3(0, 64, 0), { remainingBlocks: 0 });
    const hasStep = x => movement.getNeighbors(origin).some(step => step.x === x && step.y < 64 && step.z === 0);
    assert.equal(hasStep(1), false);
    walkStaircase(bot, () => { bot.pathfinder.movements = movement; }, new goals.GoalBlock(1, 63, 0));
    assert.equal(hasStep(1), true);
    assert.equal(hasStep(-1), false);
});

test('with three iron ingots and too little wood, autonomy returns to the known crafting table', { timeout: 5000 }, async t => {
    const pos = new Vec3(0, 12, 0);
    const station = new Vec3(-12, 24, 0);
    const table = { name: 'crafting_table', position: station };
    const items = [
        { name: 'stone_pickaxe', count: 1 }, { name: 'stone_sword', count: 1 }, { name: 'furnace', count: 1 },
        { name: 'jungle_planks', count: 3 }, { name: 'iron_ingot', count: 3 }, { name: 'apple', count: 1 },
        { name: 'cobblestone', count: 5 }, { name: 'diorite', count: 1 },
    ];
    const bot = Object.assign(new EventEmitter(), {
        username: 'devincraftbot', registry: createRegistry('1.21.1'), game: { gameMode: 'survival', dimension: 'overworld' },
        health: 20, food: 20, entity: { position: pos }, players: {}, entities: {},
        recipesFor: () => [], inventory: { items: () => items }, blockAt: point => point.equals(station) ? table : { name: 'air' },
        world: { raycast: () => table },
        pathfinder: { movements: {}, setGoal: goal => bot.emit('testGoal', goal) }, clearControlStates() {},
    });
    const behavior = attachIdle(bot, {
        isIdle: () => true, isEnabled: () => true, setWalking() {}, log() {}, greetings: { last: 0, players: new Map() },
    });
    t.after(() => behavior.close());
    bot[Symbol.for('devincraft.diamond.goal')].station('crafting_table', station);
    const [goal] = await once(bot, 'testGoal');
    assert.equal(behavior.status().type, 'walk_to_table');
    assert.equal(bot.pathfinder.movements.canDig, true);
    assert.equal(bot.pathfinder.movements.allow1by1towers, true);
    assert.deepEqual(bot.pathfinder.movements.scafoldingBlocks, ['cobblestone', 'diorite'].map(name => bot.registry.itemsByName[name].id));
    assert.equal(goal.isEnd(station.offset(1, -1, 0)), true);
    assert.equal(goal.isEnd(pos), false);

    items[0].name = 'wooden_pickaxe';
    items.find(item => item.name === 'jungle_planks').count = 1;
    items.push({ name: 'stick', count: 4 });
    bot.emit('goal_reached');
    await once(bot, 'testGoal');
    assert.equal(behavior.status().type, 'walk_to_table');
    assert.equal(bot[Symbol.for('devincraft.diamond.goal')].status().stage, 2);
});

test('when a workstation route stalls with no pickaxe, clear a dry pillar and keep approaching at station height', { timeout: 17_000 }, async t => {
    const position = new Vec3(0, 12, 0);
    const station = new Vec3(-12, 24, 0);
    const ceiling = position.offset(0, 3, 0);
    const level = new Vec3(0, 23, 0);
    const levelStep = level.offset(-1, 0, 0);
    const levelFloor = { name: 'stone', position: levelStep.offset(0, -1, 0), boundingBox: 'block' };
    let cleared = false, openLanding = true, inSwamp = false;
    const swampFloor = level.offset(0, 1, 0);
    const rock = { name: 'stone', position: ceiling, boundingBox: 'block' };
    const items = ['stone_sword', 'furnace', 'jungle_planks', 'apple'].map(name => ({ name, count: 1 }));
    items.push({ name: 'iron_ingot', count: 3 }, { name: 'cobblestone', count: 4 }, { name: 'stick', count: 4 });
    const bot = Object.assign(new EventEmitter(), {
        username: 'devincraftbot', registry: createRegistry('1.21.1'), game: { gameMode: 'survival', dimension: 'overworld' },
        health: 20, food: 20, entity: { position }, players: {}, entities: {},
        recipesFor: () => [], inventory: { items: () => items },
        blockAt: point => {
            if (inSwamp) {
                if (point.equals(swampFloor)) return { name: 'mud', boundingBox: 'block' };
                if (point.equals(swampFloor.offset(0, 1, 0))) return { name: 'vine' };
                if (point.equals(swampFloor.offset(0, 5, 0))) return { name: 'mangrove_roots', boundingBox: 'block' };
                return { name: 'air' };
            }
            if (point.equals(station)) return { name: 'crafting_table', position: station };
            if (!cleared && point.equals(ceiling)) return rock;
            if (openLanding && point.equals(levelFloor.position)) return levelFloor;
            return { name: 'air' };
        },
        world: { raycast: () => rock }, canDigBlock: block => block === rock,
        async dig(block) { assert.equal(block, rock); cleared = true; },
        pathfinder: { movements: {}, setGoal(goal) { if (goal instanceof goals.GoalBlock) bot.emit('pillar', goal); } },
        clearControlStates() {},
    });
    const behavior = attachIdle(bot, {
        isIdle: () => true, isEnabled: () => true, setWalking() {}, log() {}, greetings: { last: 0, players: new Map() },
    });
    t.after(() => behavior.close());
    const diamond = bot[Symbol.for('devincraft.diamond.goal')];
    diamond.woodStocked(true);
    diamond.station('crafting_table', station);
    const [goal] = await once(bot, 'pillar');
    assert.equal(cleared, true);
    assert.equal(goal.isEnd(position.offset(0, 1, 0)), true);
    assert.equal(bot.pathfinder.movements.allow1by1towers, true);
    bot.entity.position = level;
    bot.emit('goal_reached');
    const [approach] = await once(bot, 'pillar');
    assert.equal(behavior.status().type, 'walk_level_step');
    assert.equal(approach.isEnd(levelStep), true);
    diamond.setTableRecovery({ phase: 'attempt', expires: Date.now() - 1 });
    openLanding = false;
    bot.emit('goal_reached');
    const [shaftExit] = await once(bot, 'pillar');
    assert.equal(diamond.stations().stationPoint, undefined);
    assert.equal(diamond.tableRecovery().phase, 'restock');
    assert.equal(shaftExit.isEnd(level.offset(0, 1, 0)), true);
    inSwamp = true;
    bot.entity.position = swampFloor.offset(0, 0.875, 0);
    bot.findBlocks = () => { bot.emit('seekWood'); return []; };
    bot.emit('goal_reached');
    await once(bot, 'seekWood');
});

test('restocking routes to elevated logs instead of stopping at ground level under the drop', { timeout: 5000 }, async t => {
    const swampFloor = new Vec3(0, 63, 0);
    const dropSpot = swampFloor.offset(1, 3, 0);
    const drop = { position: dropSpot.offset(0.4, 0.1, 0.4), getDroppedItem: () => ({ name: 'mangrove_log' }) };
    const bot = Object.assign(new EventEmitter(), {
        username: 'devincraftbot', registry: createRegistry('1.21.1'), game: { gameMode: 'survival', dimension: 'overworld' },
        health: 20, food: 20, entity: { position: swampFloor.offset(0, 0.875, 0) }, players: {}, entities: {},
        recipesFor: () => [], inventory: { items: () => [{ name: 'dirt', count: 4 }] },
        blockAt: point => {
            if (point.equals(swampFloor)) return { name: 'mud', boundingBox: 'block' };
            if (point.equals(dropSpot.offset(0, -1, 0))) return { name: 'mangrove_roots', boundingBox: 'block' };
            if (point.equals(dropSpot)) return { name: 'moss_carpet' };
            return { name: 'air' };
        },
        nearestEntity: predicate => predicate(drop) ? drop : undefined,
        pathfinder: { movements: {}, setGoal(goal) { if (goal instanceof goals.GoalNear) bot.emit('dropRoute', goal); } },
        clearControlStates() {},
    });
    const behavior = attachIdle(bot, {
        isIdle: () => true, isEnabled: () => true, setWalking() {}, log() {}, greetings: { last: 0, players: new Map() },
    });
    t.after(() => behavior.close());
    bot[Symbol.for('devincraft.diamond.goal')].setTableRecovery({ phase: 'restock' });
    const [dropRoute] = await once(bot, 'dropRoute');
    assert.equal(dropRoute.isEnd(swampFloor.offset(0, 1, 0)), false);
    assert.equal(dropRoute.isEnd(dropSpot), true);
    assert.equal(bot.pathfinder.movements.allow1by1towers, true);
});

test('forest search excavates a local ascent when it cannot find a route', { timeout: 5000 }, async t => {
    const origin = new Vec3(0,55,0);
    const obstruction = origin.offset(1,3,0);
    const floor = origin.offset(1,0,0);
    const bot = Object.assign(new EventEmitter(), {
        registry: createRegistry('1.21.1'), game: { gameMode: 'survival' },
        entity: { position: origin.offset(0.5,0,0.5), onGround: true },
        health: 20, food: 20, inventory: { items: () => [] }, recipesFor: () => [], findBlocks: () => [],
        blockAt(position) {
            const solid = position.equals(origin.offset(0,-1,0)) || position.equals(floor) || position.equals(obstruction);
            return { position, name: solid ? 'stone' : 'air', boundingBox: solid ? 'block' : 'empty' };
        },
        world: { raycast: () => bot.blockAt(obstruction) },
        canDigBlock: block => block.position.equals(obstruction),
        async dig(block) { this.emit('localAscent', block.position); },
        stopDigging() {}, clearControlStates() {}, pathfinder: { setGoal() {} },
    });
    const behavior = attachIdle(bot, {
        isIdle: () => true, isEnabled: () => true, setWalking() {}, log() {},
        greetings: { last: 0, players: new Map() },
    });
    t.after(() => behavior.close());
    bot[Symbol.for('devincraft.diamond.goal')].setTableRecovery({
        phase: 'restock', forest: { origin: { x: 0, y: 55, z: 0 }, walked: 0 },
    });
    assert.deepEqual((await once(bot, 'localAscent'))[0], obstruction);
});

test('forest search replans and changes jump destination despite moderate hunger and an elevated zombie', { timeout: 22_000 }, async t => {
    const position = new Vec3(0, 64, 0);
    const hostile = { id: 1, name: 'zombie', type: 'hostile', position: position.offset(2, 4, 0) };
    const lines = [];
    const bot = Object.assign(new EventEmitter(), {
        username: 'devincraftbot', registry: createRegistry('1.21.1'), game: { gameMode: 'survival', dimension: 'overworld' },
        health: 20, food: 17, entity: { position, onGround: true }, players: {}, entities: { 1: hostile },
        recipesFor: () => [], inventory: { items: () => [] },
        blockAt: point => point.y < 64 ? { name: 'grass_block', boundingBox: 'block' } : { name: 'air' },
        world: { getBiome: point => point.x > 12 ? bot.registry.biomesByName.jungle.id : undefined },
        findBlocks: query => query.useExtraInfo ? [new Vec3(-17, 64, 0)] : [],
        findBlock: () => null, nearestEntity: () => null,
        pathfinder: { movements: {}, setGoal(goal) {
            this.goal = goal;
            if (goal) bot.emit('forestGoal', goal);
        } },
        async lookAt() {},
        setControlState(key, on) { if (key === 'jump' && on) bot.emit('forestJump'); },
        clearControlStates() {},
    });
    const behavior = attachIdle(bot, {
        isIdle: () => true, isEnabled: () => true, setWalking() {}, log: line => lines.push(line),
        greetings: { last: 0, players: new Map() },
    });
    t.after(() => behavior.close());
    const diamond = bot[Symbol.for('devincraft.diamond.goal')];
    diamond.setTableRecovery({ phase: 'restock', forest: { origin: { x: 0, y: 64, z: 0 }, walked: 0 } });
    const [first] = await once(bot, 'forestGoal');
    assert.equal(behavior.status().type, 'seek_forest');
    assert.ok(first.x < 0);
    assert.equal(bot.pathfinder.movements.allowSprinting, true);
    const [second] = await once(bot, 'forestGoal');
    assert.notDeepEqual([second.x, second.z], [first.x, first.z]);
    assert.ok(second.z !== 0 || second.x > 0);
    assert.ok(lines.some(line => line.includes('Movement stalled: seek_forest')));
    await once(bot, 'forestJump');
    assert.equal(behavior.status().type, 'hop_forest');
    const firstHop = behavior.status().target;
    await once(bot, 'forestJump');
    const nextHop = behavior.status().target;
    assert.notDeepEqual([nextHop.x, nextHop.z], [firstHop.x, firstHop.z]);
    assert.ok(lines.some(line => line.includes('Forest jump made no progress')));
});

test('a stalled tree approach tries a short step toward the trunk before picking another tree', { timeout: 9000 }, async t => {
    const origin = new Vec3(0,64,0);
    const trunk = origin.offset(8,0,0);
    const bot = Object.assign(new EventEmitter(), {
        registry: createRegistry('1.21.1'), game: { gameMode: 'survival' },
        entity: { position: origin.offset(0.5,0,0.5), onGround: true },
        health: 20, food: 20, players: {}, recipesFor: () => [], findBlocks: () => [trunk],
        inventory: { items: () => [{ name: 'dirt', count: 16 }] }, canDigBlock: () => false,
        world: { raycast: () => null },
        blockAt(point) {
            const base = point.x === trunk.x && point.z === trunk.z && point.y >= 64 && point.y <= 66;
            const leaves = point.y === 67 && point.distanceTo(trunk.offset(0,3,0)) <= 2;
            const name = base ? 'oak_log' : leaves ? 'oak_leaves' : point.y < 64 ? 'dirt' : 'air';
            return { name, position: point, boundingBox: name === 'air' ? 'empty' : 'block',
                getProperties: () => ({ axis: 'y', persistent: false }) };
        },
        async lookAt() {},
        setControlState(key, on) { if (key === 'jump' && on) this.emit('forestJump'); },
        clearControlStates() {}, pathfinder: { movements: {}, setGoal(goal) { this.goal = goal; } },
    });
    const behavior = attachIdle(bot, {
        isIdle: () => true, isEnabled: () => true, setWalking() {}, log() {},
        greetings: { last: 0, players: new Map() },
    });
    t.after(() => behavior.close());
    bot[Symbol.for('devincraft.diamond.goal')].setTableRecovery({ phase: 'restock', forest: { origin, walked: 0 } });
    await once(bot, 'forestJump');
    assert.deepEqual(behavior.status(), { type: 'hop_forest', target: { x: 1, y: 64, z: 0 } });
});

test('repeated forest route stalls clear a dry local ascent and jump out of a pit', { timeout: 25_000 }, async t => {
    const origin = new Vec3(0,64,0);
    const exit = origin.offset(1,1,0);
    const upper = exit.offset(1,1,0);
    const lines = [];
    let cleared = false;
    const bot = Object.assign(new EventEmitter(), {
        registry: createRegistry('1.21.1'), game: { gameMode: 'survival' },
        entity: { position: origin.offset(0.5,0,0.5), onGround: true },
        health: 20, food: 20, players: {}, recipesFor: () => [], findBlocks: () => [],
        inventory: { items: () => [{ name: 'dirt', count: 16 }] },
        blockAt(point) {
            const wall = Math.abs(point.x) + Math.abs(point.z) === 1 && point.y <= 65;
            const vine = point.x === origin.x && point.z === origin.z && point.y === origin.y + 3;
            const name = wall && point.y === exit.y && !point.equals(exit) ? 'bedrock'
                : point.equals(exit) && cleared ? 'air'
                    : point.y < 64 || wall || point.equals(upper.offset(0,-1,0)) ? 'stone' : vine ? 'vine' : 'air';
            return { name, position: point, boundingBox: /^(stone|bedrock)$/.test(name) ? 'block' : 'empty' };
        },
        world: { raycast: (from, direction, distance) => bot.blockAt(from.plus(direction.scaled(distance - 0.02)).floored()) },
        canDigBlock: () => true, async dig(block) { cleared = true; this.emit('cleared', block.position); },
        async lookAt() {},
        setControlState(control, value) {
            if (!value) return;
            assert.equal(this.pathfinder.goal, null);
            if (control === 'jump') {
                this.entity.position = this.entity.position.offset(0,1.2,0);
                this.entity.onGround = false;
            }
            if (control === 'forward') {
                const landing = this.entity.position.x < exit.x ? exit : upper;
                assert.ok(this.entity.position.y >= landing.y);
                this.entity.position = landing.offset(0.5,0,0.5);
                this.entity.onGround = true;
            }
        },
        stopDigging() {}, clearControlStates() {}, pathfinder: { movements: {}, setGoal(goal) { this.goal = goal; } },
    });
    const behavior = attachIdle(bot, {
        isIdle: () => true, isEnabled: () => true, setWalking() {}, log(line) {
            lines.push(line);
            if (line.startsWith('Forest ascent: landed')) bot.emit('landed');
        },
        greetings: { last: 0, players: new Map() },
    });
    t.after(() => behavior.close());
    bot[Symbol.for('devincraft.diamond.goal')].setTableRecovery({ phase: 'restock', forest: { origin, walked: 0 } });
    const [point] = await once(bot, 'cleared');
    assert.equal(point.y, origin.y + 1);
    assert.equal(Math.abs(point.x) + Math.abs(point.z), 1);
    assert.equal(lines.filter(line => line.includes('Movement stalled: seek_forest')).length, 2);
    assert.ok(lines.some(line => line.includes('taking a dry ascent')));
    assert.deepEqual(point, exit);
    await once(bot, 'landed');
    assert.deepEqual(bot.entity.position.floored(), exit);
    await once(bot, 'landed');
    assert.deepEqual(bot.entity.position.floored(), upper);
    assert.equal(lines.filter(line => line.includes('Movement stalled: seek_forest')).length, 2);
});

test('after two failed escape attempts a forest pillar preserves the reserve and walks off toward the goal', { timeout: 36_000 }, async t => {
    const origin = new Vec3(0,64,0);
    const dirt = { name: 'dirt', count: 19 };
    const placed = [];
    let aim;
    const bot = Object.assign(new EventEmitter(), {
        registry: createRegistry('1.21.1'), game: { gameMode: 'survival' },
        entity: { position: origin.offset(0.5,0,0.5), onGround: true },
        health: 20, food: 20, players: {}, recipesFor: () => [], findBlocks: () => [],
        inventory: { items: () => [dirt] },
        blockAt(point) {
            const rim = Math.abs(point.x) + Math.abs(point.z) === 1 && point.y === 66;
            const name = placed.some(block => block.equals(point)) ? 'dirt' : point.y < 64 || rim ? 'grass_block' : 'air';
            return { name, position: point, boundingBox: name === 'air' ? 'empty' : 'block' };
        },
        async equip(item) { assert.equal(item, dirt); },
        async lookAt(point) { aim = point; },
        async look(yaw, pitch) { assert.equal(pitch, -Math.PI / 2); },
        setControlState(control, value) {
            if (!value) return;
            assert.equal(this.pathfinder.goal, null);
            if (control === 'jump') {
                this.entity.position = this.entity.position.offset(0,1.2,0);
                this.entity.onGround = false;
            }
            if (control === 'forward') {
                assert.equal(placed.length, 3);
                this.entity.position = new Vec3(aim.x, 67, aim.z);
            }
        },
        async placeBlock(anchor, face) {
            placed.push(anchor.position.plus(face));
            this.entity.position = origin.offset(0.5, placed.length, 0.5);
            this.entity.onGround = true;
            dirt.count--;
        },
        clearControlStates() {}, pathfinder: { movements: {}, setGoal(goal) { this.goal = goal; } },
    });
    const behavior = attachIdle(bot, {
        isIdle: () => true, isEnabled: () => true, setWalking() {}, log(line) {
            if (line.startsWith('Forest escape: walked off')) bot.emit('escaped');
        },
        greetings: { last: 0, players: new Map() },
    });
    t.after(() => behavior.close());
    bot[Symbol.for('devincraft.diamond.goal')].setTableRecovery({ phase: 'restock', forest: { origin, walked: 0 } });
    await once(bot, 'escaped');
    assert.deepEqual(placed, [origin, origin.offset(0,1,0), origin.offset(0,2,0)]);
    assert.equal(dirt.count, 16);
    const landing = bot.entity.position.floored();
    assert.equal(landing.y, 67);
    assert.equal(Math.abs(landing.x) + Math.abs(landing.z), 1);
});

for (const variant of ['roots', 'water base', 'dry slot', 'a recoverable canopy platform', 'a site away from a cliff']) {
    test(`bootstrap places a carried table using ${variant}`, { timeout: 5000 }, async t => {
        const feet = new Vec3(0,64,0);
        const floor = feet.offset(1,-1,0);
        const registry = createRegistry('1.21.1');
        const items = [{ name: 'crafting_table', count: 1 }, { name: 'oak_planks', count: 12 }, { name: 'stick', count: 4 }];
        if (variant === 'water base') items.push({ name: 'dirt', count: 1 });
        const terrain = new Map([[feet.offset(0,-1,0).toString(), 'muddy_mangrove_roots'], [floor.toString(),
            { roots: 'mangrove_roots', 'water base': 'water', 'dry slot': 'grass_block' }[variant]]]);
        const canopy = variant === 'a recoverable canopy platform';
        const cliff = variant === 'a site away from a cliff';
        if (canopy) {
            terrain.set(feet.offset(2,0,0).toString(), 'mangrove_log');
            terrain.set(feet.offset(-1,-1,0).toString(), 'mangrove_leaves');
            for (const [x,z] of [[-2,0],[-1,-1],[-1,1]])
                terrain.set(feet.offset(x,-3,z).toString(), 'dirt');
        }
        if (cliff) {
            terrain.set(floor.toString(), 'dirt');
            terrain.set(feet.offset(-1,-1,0).toString(), 'dirt');
        }
        const actions = [];
        const bot = Object.assign(new EventEmitter(), {
            registry, game: { gameMode: 'survival', dimension: 'overworld' }, health: 20, food: 20,
            entity: { position: feet.offset(0.5,0,0.5) }, entities: {}, inventory: { items: () => items },
            blockAt(position) {
                const inPlayerColumn = position.x === feet.x && position.z === feet.z && position.y >= feet.y;
                const name = terrain.get(position.toString()) ?? ((variant === 'roots' || variant === 'water base'
                    || cliff && position.x < 2)
                    && position.y === feet.y - 3 ? 'stone' : variant === 'dry slot' && !inPlayerColumn ? 'bedrock'
                    : variant === 'water base' && position.y < feet.y ? 'water' : 'air');
                return { name, position, boundingBox: /^(air|water)$/.test(name) ? 'empty' : 'block' };
            },
            world: { raycast: (from, direction, distance) => bot.blockAt(from.plus(direction.scaled(distance - 0.02)).floored()) },
            canDigBlock: block => block.name === 'grass_block',
            async dig(block) {
                actions.push(['dig', block.name]);
                terrain.set(block.position.toString(), 'air');
            },
            async equip(item) { this.heldItem = item; },
            async placeBlock(reference, face) {
                const target = reference.position.plus(face);
                assert.match(this.blockAt(target).name, /^(air|water)$/);
                actions.push(['place', this.heldItem.name, reference.name, target.toString()]);
                terrain.set(target.toString(), this.heldItem.name);
            },
            recipesFor: id => [{ name: registry.items[id].name }],
            async craft(recipe, count, workbench) {
                assert.equal(workbench.name, 'crafting_table');
                assert.equal(recipe.name, 'wooden_pickaxe');
                this.emit('crafted');
            },
            clearControlStates() {}, pathfinder: { setGoal() {} },
        });
        const behavior = attachIdle(bot, {
            isIdle: () => true, isEnabled: () => true, setWalking() {}, log() {}, greetings: { last: 0, players: new Map() },
        });
        t.after(() => behavior.close());
        bot[Symbol.for('devincraft.diamond.goal')].woodStocked(true);
        await once(bot, 'crafted');
        const above = floor.offset(0,1,0).toString();
        if (canopy) {
            assert.deepEqual(actions, [['place', 'crafting_table', 'mangrove_leaves', feet.offset(-1,0,0).toString()]]);
            return;
        }
        if (cliff) {
            assert.deepEqual(actions, [['place', 'crafting_table', 'dirt', feet.offset(-1,0,0).toString()]]);
            return;
        }
        assert.deepEqual(actions, variant === 'roots' ? [['place', 'crafting_table', 'mangrove_roots', above]]
            : variant === 'water base' ? [['place', 'dirt', 'muddy_mangrove_roots', floor.toString()],
                ['place', 'crafting_table', 'dirt', above]]
                : [['dig', 'grass_block'], ['place', 'crafting_table', 'bedrock', floor.toString()]]);
    });
}

test('restock crafts an iron pickaxe first at hunger 14 and packs the table from solid ground', { timeout: 10_000 }, async t => {
    const position = new Vec3(0.5, 64, 0.5);
    const registry = createRegistry('1.21.1');
    const items = [['mangrove_log', 1], ['iron_ingot', 3], ['stick', 4], ['furnace', 1], ['stone_sword', 1]]
        .map(([name,count]) => ({ name, count }));
    const crafted = [];
    const add = (name, count = 1) => items.push({ name, count });
    const take = (name, count) => {
        const item = items.find(i => i.name === name);
        item.count -= count;
        if (!item.count) items.splice(items.indexOf(item), 1);
    };
    let table;
    const bot = Object.assign(new EventEmitter(), {
        username: 'devincraftbot', registry, game: { gameMode: 'survival', dimension: 'overworld' },
        health: 20, food: 14, entity: { position, onGround: true }, players: {}, entities: {},
        inventory: { items: () => items },
        blockAt: point => point.equals(table ?? new Vec3(0,0,0)) && table
            ? { position: point, name: 'crafting_table', boundingBox: 'block' }
            : { position: point, name: point.y < 64 ? 'grass_block' : 'air', boundingBox: point.y < 64 ? 'block' : 'empty' },
        world: { raycast: (from, direction, distance) => bot.blockAt(from.plus(direction.scaled(distance - 0.02)).floored()) },
        findBlock: () => null, findBlocks: () => [], canDigBlock: () => true,
        nearestEntity: predicate => Object.values(bot.entities).find(predicate),
        recipesFor: id => [{ name: registry.items[id].name }],
        async craft(recipe, count, workbench) {
            crafted.push(recipe.name);
            if (recipe.name === 'mangrove_planks') { take('mangrove_log', 1); add(recipe.name, 4); }
            if (recipe.name === 'crafting_table') { take('mangrove_planks', 4); add(recipe.name); }
            if (recipe.name === 'iron_pickaxe') {
                assert.equal(workbench.name, 'crafting_table');
                take('iron_ingot', 3); take('stick', 2); add(recipe.name);
            }
        },
        async equip() {},
        async placeBlock(block, face) { take('crafting_table', 1); table = block.position.plus(face); },
        async dig(block) {
            assert.equal(block.name, 'crafting_table');
            table = undefined;
            bot.entities[1] = { id: 1, position: block.position.offset(0.5,0.15,0.5), getDroppedItem: () => ({ name: 'crafting_table' }) };
        },
        async lookAt() {},
        setControlState(key, on) {
            if (key === 'forward' && on && bot.entities[1]) {
                delete bot.entities[1]; add('crafting_table'); bot.emit('packed');
            }
        },
        pathfinder: { setGoal(goal) { this.goal = goal; } }, clearControlStates() {},
    });
    const behavior = attachIdle(bot, {
        isIdle: () => true, isEnabled: () => true, setWalking() {}, log() {}, greetings: { last: 0, players: new Map() },
    });
    t.after(() => behavior.close());
    const diamond = bot[Symbol.for('devincraft.diamond.goal')];
    diamond.setTableRecovery({ phase: 'restock' });
    await once(bot, 'packed');
    assert.deepEqual(crafted, ['mangrove_planks', 'crafting_table', 'iron_pickaxe']);
    assert.equal(items.find(i => i.name === 'stick').count, 2);
    assert.ok(items.some(i => i.name === 'crafting_table'));
});

test('diamond progression packs both stations and crafts spare sticks before descent', { timeout: 5000 }, async t => {
    const position = new Vec3(0, 30, 0);
    const items = ['iron_pickaxe', 'stone_sword', 'furnace', 'crafting_table', 'apple']
        .map(name => ({ name, count: 1 }));
    items.push({ name: 'iron_helmet', count: 1 }, { name: 'iron_chestplate', count: 1 });
    items.push({ name: 'oak_planks', count: 3 });
    items.push({ name: 'jungle_log', count: 2 });
    const bot = Object.assign(new EventEmitter(), {
        username: 'devincraftbot', registry: createRegistry('1.21.1'), game: { gameMode: 'survival', dimension: 'overworld' },
        health: 20, food: 20, entity: { position }, players: {}, entities: {}, inventory: { items: () => items },
        recipesFor: id => [{ id }], craft: async recipe => { bot.emit('crafted', recipe.id); },
        blockAt: () => ({ name: 'air' }), pathfinder: { setGoal: goal => { if (goal) assert.fail('Descended without spare sticks'); } },
        clearControlStates() {},
    });
    const behavior = attachIdle(bot, {
        isIdle: () => true, isEnabled: () => true, setWalking() {}, log() {}, greetings: { last: 0, players: new Map() },
    });
    t.after(() => behavior.close());
    const [id] = await once(bot, 'crafted');
    assert.equal(id, bot.registry.itemsByName.stick.id);
});

test('wood resupply searches for logs and replans after a stalled wander goal', { timeout: 8000 }, async t => {
    const items = ['stone_pickaxe', 'stone_sword', 'furnace', 'crafting_table', 'oak_planks'].map(name => ({ name, count: 1 }));
    let woodScans = 0;
    const bot = Object.assign(new EventEmitter(), {
        registry: createRegistry('1.21.1'),
        game: { gameMode: 'survival', minY: 0, height: 70 }, entity: { position: new Vec3(0,64,0) }, players: {}, entities: {},
        health: 20, food: 20, inventory: { items: () => items }, recipesFor: () => [],
        blockAt: p => ({ position: p, name: p.y < 64 ? 'stone' : 'air', boundingBox: p.y < 64 ? 'block' : 'empty' }),
        findBlocks({ matching }) {
            if (matching({ name: 'oak_log' })) woodScans++;
            return [];
        },
        pathfinder: { setGoal(goal) { this.goal = goal; if (goal) bot.emit('wanderGoal', goal); } }, clearControlStates() {},
    });
    const behavior = attachIdle(bot, {
        isIdle: () => true, isEnabled: () => true, setWalking() {},
        log(line) { if (line.startsWith('Movement stalled: wander')) bot.emit('wanderStalled'); },
        greetings: { last: 0, players: new Map() },
    });
    t.after(() => behavior.close());
    const [first] = await once(bot, 'wanderGoal');
    const [, [second]] = await Promise.all([once(bot, 'wanderStalled'), once(bot, 'wanderGoal')]);
    assert.notEqual(first, second);
    assert.ok(woodScans > 0);
});

test('iron search makes replacement sticks from carried logs without requiring the deep reserve', { timeout: 5000 }, async t => {
    const items = ['stone_pickaxe', 'stone_sword', 'furnace', 'crafting_table', 'oak_planks'].map(name => ({ name, count: 1 }));
    items.push({ name: 'oak_log', count: 2 });
    const crafted = [];
    const bot = Object.assign(new EventEmitter(), {
        registry: createRegistry('1.21.1'), game: { gameMode: 'survival' },
        entity: { position: new Vec3(0,45,0) }, players: {}, entities: {}, health: 20, food: 20,
        inventory: { items: () => items }, recipesFor: id => [{ name: bot.registry.items[id].name }],
        async craft(recipe) {
            crafted.push(recipe.name);
            if (recipe.name === 'oak_planks') {
                items.find(i => i.name === 'oak_log').count--;
                items.find(i => i.name === 'oak_planks').count += 4;
            } else if (recipe.name === 'stick') bot.emit('sticks');
        },
        blockAt: p => ({ position: p, name: p.y < 45 ? 'stone' : 'air', boundingBox: p.y < 45 ? 'block' : 'empty' }),
        pathfinder: { setGoal: goal => assert.equal(goal, null) }, clearControlStates() {},
    });
    const behavior = attachIdle(bot, {
        isIdle: () => true, isEnabled: () => true, setWalking() {}, log() {}, greetings: { last: 0, players: new Map() },
    });
    t.after(() => behavior.close());
    await once(bot, 'sticks');
    assert.deepEqual(crafted, ['oak_planks', 'stick']);
});

async function checkIronSearchAscent(t, y, deep, restocking = false) {
    const position = new Vec3(0,y,0);
    const items = ['stone_pickaxe', 'stone_sword', 'furnace', 'crafting_table'].map(name => ({ name, count: 1 }));
    if (restocking) items.push({ name: 'oak_planks', count: 1 }, { name: 'iron_pickaxe', count: 1 });
    else items.push({ name: 'stick', count: 2 }, { name: 'oak_planks', count: 8 });
    if (deep) items.push({ name: 'diamond', count: 5 });
    const bot = Object.assign(new EventEmitter(), {
        username: 'devincraftbot', registry: createRegistry('1.21.1'), game: { gameMode: 'survival', dimension: 'overworld' },
        health: 20, food: 10, entity: { position }, players: {}, entities: {},
        inventory: { items: () => items }, recipesFor: () => [], findBlocks: () => [],
        blockAt(point) {
            const empty = point.x === 0 && point.z === 0 && (point.y === y || point.y === y + 1);
            const ore = restocking && point.equals(position.offset(0,2,0));
            return { position: point, name: empty ? 'air' : ore ? 'deepslate_redstone_ore' : 'deepslate',
                boundingBox: empty ? 'empty' : 'block' };
        },
        canDigBlock: () => true, world: { raycast: () => bot.blockAt(position.offset(0,2,0)) },
        async equip() {}, async dig(block) { bot.emit('dug', block.position); },
        pathfinder: { setGoal: goal => assert.equal(goal, null) }, clearControlStates() {}, stopDigging() {},
    });
    const behavior = attachIdle(bot, {
        isIdle: () => true, isEnabled: () => true, setWalking() {}, log() {}, greetings: { last: 0, players: new Map() },
    });
    t.after(() => behavior.close());
    if (deep) bot[Symbol.for('devincraft.diamond.goal')].advance({ heading: 0, spine: 12 });
    assert.deepEqual(await once(bot, 'dug'), [position.offset(0,2,0)]);
}

test('iron resupply after reaching diamond level starts opening an upward route', { timeout: 5000 }, async t => {
    await checkIronSearchAscent(t, -58, true);
});

test('initial iron search below Y=16 opens an upward route even without a diamond route', { timeout: 5000 }, async t => {
    await checkIronSearchAscent(t, -46, false);
});

test('wood restocking with an iron pickaxe clears dry redstone ore from the ascent', { timeout: 5000 }, async t => {
    await checkIronSearchAscent(t, -10, false, true);
});

for (const unstable of [false, true]) {
    test(unstable ? 'ascent rejects a remembered waypoint below gravel' : 'ascent prefers the safe recorded staircase',
        { timeout: 5000 }, async t => {
            const start = new Vec3(0,0,0);
            const back = start.offset(-1,1,0);
            const east = start.offset(1,1,0);
            const items = ['iron_pickaxe', 'stone_sword', 'crafting_table', 'furnace', 'stick', 'oak_planks']
                .map(name => ({ name, count: 2 }));
            const bot = Object.assign(new EventEmitter(), {
                game: { gameMode: 'survival', dimension: 'overworld' }, entity: { position: start.offset(0.5,0,0.5) },
                inventory: { items: () => items }, health: 20, food: 20, players: {}, entities: {}, recipesFor: () => [],
                findBlocks: () => [], clearControlStates() {},
                blockAt(position) {
                    const name = unstable && position.equals(back.offset(0,3,0)) ? 'gravel'
                        : position.y < ((position.x === 1 || position.x === -1) && position.z === 0 ? 1 : 0) ? 'stone' : 'air';
                    return { position, name, boundingBox: name === 'air' ? 'empty' : 'block' };
                },
                pathfinder: { movements: { exclusionAreasStep: [] }, setGoal(goal) { if (goal) bot.emit('stepGoal', goal); } },
            });
            const behavior = attachIdle(bot, {
                isIdle: () => true, isEnabled: () => true, setWalking() {}, log() {}, greetings: { last: 0, players: new Map() },
            });
            t.after(() => behavior.close());
            bot[Symbol.for('devincraft.diamond.goal')].recordStair(back, start);
            const [goal] = await once(bot, 'stepGoal');
            assert.ok(goal.isEnd(unstable ? east : back));
        });
}

test('suffocation immediately clears the head and feet and steps into air despite low health', { timeout: 5000 }, async t => {
    const feet = new Vec3(0,0,0);
    const head = feet.offset(0,1,0);
    const exit = feet.offset(1,0,0);
    const blocked = new Set([head.toString(), feet.toString()]);
    const actions = [];
    const bot = Object.assign(new EventEmitter(), {
        game: { gameMode: 'survival' }, entity: { position: feet.offset(0.5,0,0.5) }, health: 4, food: 5,
        inventory: { items: () => [] }, players: {}, entities: {},
        blockAt(position) {
            const solid = position.y < 0 || blocked.has(position.toString());
            return { position, name: solid ? 'gravel' : 'air', boundingBox: solid ? 'block' : 'empty' };
        },
        pathfinder: { setGoal: goal => assert.equal(goal, null) }, clearControlStates() {},
        canDigBlock: () => true, async dig(block) {
            actions.push(block.position.toString());
            blocked.delete(block.position.toString());
        },
        async lookAt(point) { assert.equal(point.x, exit.x + 0.5); },
        setControlState(key, value) {
            assert.equal(key, 'forward');
            assert.equal(value, true);
            this.entity.position = exit.offset(0.5,0,0.5);
            this.emit('escaped');
        },
    });
    const behavior = attachIdle(bot, {
        isIdle: () => true, isEnabled: () => true, setWalking() {}, log() {}, greetings: { last: 0, players: new Map() },
    });
    t.after(() => behavior.close());
    const escaped = once(bot, 'escaped');
    bot.pi_recentDamage = { type: 'in_wall', at: Date.now() };
    bot.emit('entityHurt', bot.entity);
    assert.equal(behavior.status().type, 'escape_suffocation');
    await escaped;
    assert.deepEqual(actions, [head.toString(), feet.toString()]);
});

test('stage four mines more iron rather than exposed diamond before the helmet and chestplate', { timeout: 5000 }, async t => {
    const feet = new Vec3(0,-24,0);
    const iron = feet.offset(1,0,0);
    const diamond = feet.offset(-1,0,0);
    const items = ['iron_pickaxe', 'stone_sword', 'furnace', 'crafting_table'].map(name => ({ name, count: 1 }));
    items.push({ name: 'stick', count: 2 }, { name: 'oak_planks', count: 8 });
    const bot = Object.assign(new EventEmitter(), {
        game: { gameMode: 'survival', dimension: 'overworld' }, entity: { position: feet.offset(0.5,0,0.5) },
        health: 20, food: 20, entities: {}, inventory: { items: () => items }, recipesFor: () => [],
        blockAt(position) {
            const name = position.equals(iron) ? 'iron_ore' : position.equals(diamond) ? 'diamond_ore'
                : position.y < feet.y ? 'stone' : 'air';
            return { name, position, boundingBox: name === 'air' ? 'empty' : 'block' };
        },
        world: { raycast: (from, direction, distance) => bot.blockAt(from.plus(direction.scaled(distance - 0.02)).floored()) },
        findBlocks: ({ matching }) => [iron, diamond].filter(point => matching(bot.blockAt(point))),
        canDigBlock: () => true, async equip() {}, async dig(block) { this.emit('dug', block.name); },
        pathfinder: { setGoal: goal => assert.equal(goal, null) }, clearControlStates() {}, stopDigging() {},
    });
    const behavior = attachIdle(bot, {
        isIdle: () => true, isEnabled: () => true, setWalking() {}, log() {}, greetings: { last: 0, players: new Map() },
    });
    t.after(() => behavior.close());
    assert.deepEqual(await once(bot, 'dug'), ['iron_ore']);
});

for (const [fuel, fuelCount, oreCount, expectedFuel] of [['coal', 1, 3, 1], ['oak_planks', 3, 2, 2]]) {
    test(`stage four batches iron with ${fuel} for the first pickaxe`, { timeout: 5000 }, async t => {
        const registry = createRegistry('1.21.1');
        const feet = new Vec3(0,-14,0);
        const furnace = { name: 'furnace', position: feet.offset(1,0,0), boundingBox: 'block' };
        const items = [['stone_pickaxe', 1], ['stone_sword', 1], ['crafting_table', 1], ['stick', 2],
            ['raw_iron', oreCount], ['iron_ingot', 1], [fuel, fuelCount]]
            .map(([name, count]) => ({ name, count, type: registry.itemsByName[name].id }));
        if (fuel === 'coal') items.push({ name: 'oak_planks', count: 1, type: registry.itemsByName.oak_planks.id });
        let loaded;
        const bot = Object.assign(new EventEmitter(), {
            registry, game: { gameMode: 'survival', dimension: 'overworld' }, entity: { position: feet.offset(0.5,0,0.5) },
            health: 20, food: 20, players: {}, entities: {}, inventory: { items: () => items }, recipesFor: () => [],
            blockAt: position => position.equals(furnace.position) ? furnace : { position, name: 'air', boundingBox: 'empty' },
            world: { raycast: () => furnace },
            async openFurnace() {
                return {
                    outputItem: () => null, inputItem: () => null, fuelItem: () => loaded, close() {},
                    async putFuel(type, metadata, count) { loaded = { name: registry.items[type].name, count }; },
                    async putInput(type, metadata, count) { bot.emit('loaded', registry.items[type].name, count); },
                };
            },
            pathfinder: { setGoal: goal => assert.equal(goal, null) }, clearControlStates() {},
        });
        const behavior = attachIdle(bot, {
            isIdle: () => true, isEnabled: () => true, setWalking() {}, log() {}, greetings: { last: 0, players: new Map() },
        });
        t.after(() => behavior.close());
        bot[Symbol.for('devincraft.diamond.goal')].station('furnace', furnace.position);
        assert.deepEqual(await once(bot, 'loaded'), ['raw_iron', oreCount]);
        assert.deepEqual(loaded, { name: fuel, count: expectedFuel });
    });
}

test('stage six reserves three sticks for both diamond tools before crafting either', { timeout: 5000 }, async t => {
    const items = ['iron_pickaxe', 'stone_sword', 'furnace', 'crafting_table'].map(name => ({ name, count: 1 }));
    items.push({ name: 'stick', count: 2 }, { name: 'oak_planks', count: 2 }, { name: 'diamond', count: 29 });
    const bot = Object.assign(new EventEmitter(), {
        username: 'devincraftbot', registry: createRegistry('1.21.1'), game: { gameMode: 'survival', dimension: 'overworld' },
        health: 20, food: 11, entity: { position: new Vec3(0,-58,0) }, players: {}, entities: {},
        inventory: { items: () => items }, recipesFor: id => [{ id }],
        craft: async recipe => { bot.emit('crafted', recipe.id); },
        blockAt: () => ({ name: 'air' }),
        pathfinder: { setGoal: goal => assert.equal(goal, null) }, clearControlStates() {},
    });
    const behavior = attachIdle(bot, {
        isIdle: () => true, isEnabled: () => true, setWalking() {}, log() {}, greetings: { last: 0, players: new Map() },
    });
    t.after(() => behavior.close());
    const [id] = await once(bot, 'crafted');
    assert.equal(id, bot.registry.itemsByName.stick.id);
});

test('autonomy equips the full crafted diamond armor and counts worn pieces in the kit', { timeout: 5000 }, async t => {
    const items = [...Object.keys(diamondKit), 'stone_sword', 'crafting_table', 'furnace', 'oak_planks']
        .map(name => ({ name, count: 1 }));
    const slots = [];
    const destination = { head: 5, torso: 6, legs: 7, feet: 8 };
    let reported;
    const bot = Object.assign(new EventEmitter(), {
        username: 'devincraftbot', registry: createRegistry('1.21.1'), game: { gameMode: 'survival', dimension: 'overworld' },
        health: 20, food: 11, entity: { position: new Vec3(0,-58,0) }, players: {}, entities: {},
        getEquipmentDestSlot: slot => destination[slot],
        inventory: { items: () => items, slots }, recipesFor: () => [],
        async equip(item, slot) {
            slots[destination[slot]] = item;
            items.splice(items.indexOf(item), 1);
            if (slot === 'feet') {
                reported = bot[Symbol.for('devincraft.diamond.goal')].snapshot();
                bot.emit('armorEquipped');
            }
        },
        blockAt: () => ({ name: 'air' }),
        pathfinder: { setGoal: goal => assert.equal(goal, null) }, clearControlStates() {},
    });
    const behavior = attachIdle(bot, {
        isIdle: () => true, isEnabled: () => true, setWalking() {}, log() {}, greetings: { last: 0, players: new Map() },
    });
    t.after(() => behavior.close());
    await once(bot, 'armorEquipped');
    assert.deepEqual(reported.equippedArmor, {
        head: 'diamond_helmet', torso: 'diamond_chestplate', legs: 'diamond_leggings', feet: 'diamond_boots',
    });
    assert.equal(reported.complete, true);
    assert.equal(reported.diamonds.investedInKit, 29);
});

test('Netherite phases wait for the equipped diamond kit and preserve its diamond budget as armor is upgraded', () => {
    const armor = { head: 'diamond_helmet', torso: 'diamond_chestplate', legs: 'diamond_leggings', feet: 'diamond_boots' };
    const items = [...Object.keys(diamondKit), 'oak_planks'].map(name => ({ name, count: 1 }));
    const context = { alive: true, safe: true, food: 20, station: true, furnace: true, dimension: 'overworld' };
    const state = () => assess(items, context);
    assert.equal(state().stage, 6);
    assert.equal(state().netherite.unlocked, false);
    context.equippedArmor = { ...armor };
    assert.equal(state().stage, 7);
    assert.equal(state().netherite.inNether, false);
    context.portalReady = true;
    assert.equal(state().netherite.portalReady, true);
    context.dimension = 'the_nether';
    context.portalBuilt = true;
    context.equippedArmor.feet = 'golden_boots';
    assert.equal(state().stage, 8);
    assert.equal(state().netherite.inNether, true);
    items.push({ name: 'netherite_ingot', count: 1 }, { name: 'netherite_upgrade_smithing_template', count: 1 });
    assert.equal(state().stage, 9);
    for (const [slot, item] of Object.entries(armor)) {
        const upgraded = item.replace('diamond_', 'netherite_');
        items.find(entry => entry.name === item).name = upgraded;
        context.equippedArmor[slot] = upgraded;
    }
    assert.equal(state().stage, 10);
    assert.equal(state().netherite.complete, true);
    assert.deepEqual(state().missingKit, []);
    assert.equal(state().diamonds.investedInKit, 29);
    items.splice(items.findIndex(item => item.name === 'netherite_helmet'), 1);
    assert.equal(state().netherite.unlocked, false);
});

test('post-diamond autonomy completes and lights a dry portal, then enters with gold boots', { timeout: 5500 }, async t => {
    const base = new Vec3(0,69,0), foot = base.offset(2,0,-1);
    const cells = new Map();
    const cell = (x,y) => foot.offset(0,y,x);
    for (let y = 0; y < 5; y++) for (let x = 0; x < 4; x++) {
        if (x === 0 || x === 3 || y === 0 || y === 4) cells.set(cell(x,y).toString(), 'obsidian');
    }
    const missing = cell(1,0);
    cells.delete(missing.toString());
    const items = [...Object.keys(diamondKit), 'oak_planks', 'crafting_table', 'furnace', 'flint_and_steel', 'obsidian',
        'shield', 'golden_boots', 'cooked_beef'].map(name => ({ name, count: 1 }));
    items.push({ name: 'cobblestone', count: 16 });
    const destination = { head: 5, torso: 6, legs: 7, feet: 8, 'off-hand': 45 };
    const slots = [];
    for (const [slot,name] of Object.entries({ head: 'diamond_helmet', torso: 'diamond_chestplate', legs: 'diamond_leggings',
        feet: 'diamond_boots', 'off-hand': 'shield' })) slots[destination[slot]] = items.find(item => item.name === name);
    let reference, jumping = false;
    const bot = Object.assign(new EventEmitter(), {
        username: 'devincraftbot', registry: createRegistry('1.21.1'), entity: { position: base.offset(0.5,0,0.5), onGround: true },
        game: { gameMode: 'survival', dimension: 'overworld' }, time: { timeOfDay: 6000 },
        health: 20, food: 20, players: {}, entities: {}, inventory: { items: () => items, slots },
        blockAt(point) {
            const name = cells.get(point.toString()) ?? (point.y < base.y ? 'grass_block' : 'air');
            const block = { name, position: point, boundingBox: /^(air|nether_portal)$/.test(name) ? 'empty' : 'block' };
            if (point.equals(missing.offset(0,-1,0))) reference = block;
            return block;
        },
        world: { raycast: () => reference }, getEquipmentDestSlot: slot => destination[slot],
        async equip(item, slot) {
            if (slot === 'feet') slots[destination.feet] = item;
            else this.heldItem = item;
        },
        async lookAt() {},
        setControlState(name, enabled) {
            if (name === 'jump') jumping = enabled;
            if (name === 'forward' && enabled && jumping) {
                assert.equal(slots[destination.feet].name, 'golden_boots');
                this.entity.position = cell(1,1).offset(0.5,0,0.5);
                this.game.dimension = 'the_nether';
                this.emit('entered');
            }
        },
        async placeBlock(anchor, face) {
            const target = anchor.position.plus(face);
            assert.deepEqual(target, missing);
            assert.equal(this.heldItem.name, 'obsidian');
            cells.set(target.toString(), 'obsidian');
        },
        async activateBlock(block, face) {
            assert.deepEqual(block.position, missing);
            assert.deepEqual(face, new Vec3(0,1,0));
            assert.equal(this.heldItem.name, 'flint_and_steel');
            for (const x of [1,2]) for (const y of [1,2,3]) cells.set(cell(x,y).toString(), 'nether_portal');
        },
        recipesFor: () => [], pathfinder: { setGoal() {} }, clearControlStates() {},
    });
    const behavior = attachIdle(bot, { isIdle: () => true, isEnabled: () => true, setWalking() {},
        greetings: { last: 0, players: new Map() },
        log(line) { if (line.startsWith('Nether portal lit')) bot.emit('portalLit'); },
    });
    t.after(() => behavior.close());
    const goal = bot[Symbol.for('devincraft.diamond.goal')];
    goal.setSpawnRelocation({ origin: { ...base }, base: { ...base } });
    await once(bot, 'portalLit');
    assert.equal(goal.snapshot().netherite.portalReady, true);
    assert.equal(goal.status().netherite.inNether, false);
    bot.entity.position = base.offset(1.5,0,0.5);
    await once(bot, 'entered');
    assert.equal(goal.snapshot().stage, 8);
});

test('diamond progress persists across bot instances and live stage can regress after death', async t => {
    const directory = await mkdtemp(path.join(__dirname, 'goal-test-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const file = path.join(directory, 'progress.json');
    const bot = items => Object.assign(new EventEmitter(), { inventory: { items: () => items },
        entity: { position: new Vec3(0, -58, 0) }, health: 20, food: 20, game: { dimension: 'overworld' } });
    const player = bot(['iron_pickaxe', 'stone_sword', 'oak_planks', 'cooked_beef', 'furnace', 'crafting_table', 'diamond']
        .map(name => ({ name, count: 1 })));
    player.inventory.items().push({ name: 'iron_helmet', count: 1 }, { name: 'iron_chestplate', count: 1 });
    const attach = current => attachDiamond(current, (_bot, name) => name === 'cooked_beef', { file });
    const before = attach(player);
    assert.equal(before.snapshot().stage, 5);
    before.advance({ heading: 2, spine: 3 });
    before.setStatusLoop(false);
    await before.flush();
    assert.equal(JSON.parse(await readFile(file, 'utf8')).route.heading, 2);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).statusLoopEnabled, false);
    player.emit('death');
    await before.flush();
    before.close();
    const after = attach(bot([]));
    assert.equal(after.statusLoopEnabled(), false);
    const state = after.snapshot();
    assert.equal(state.stage, 2);
    assert.equal(state.peakStage, 5);
    assert.equal(state.deaths, 1);
    assert.equal(state.diamonds.highWater, 1);
    assert.equal(after.route(), null);
    const { at, ...site } = after.deathSite();
    assert.deepEqual(site, { x: 0, y: -58, z: 0, dimension: 'overworld' });
    assert.ok(Date.now() - at < 4000);
    await after.flush();
    after.close();
});

test('respawn prioritizes returning to reachable death drops before new gear', { timeout: 5000 }, async t => {
    const site = new Vec3(7,64,0);
    const drop = { id: 1, position: site.clone(), getDroppedItem: () => ({ name: 'diamond' }) };
    const bot = Object.assign(new EventEmitter(), {
        game: { gameMode: 'survival', dimension: 'overworld' }, entity: { position: site.clone() },
        entities: { 1: drop }, health: 20, food: 20,
        inventory: { items: () => [] },
        nearestEntity: test => test(drop) ? drop : undefined,
        blockAt: () => ({ name: 'air' }),
        clearControlStates() {},
        pathfinder: { movements: {}, setGoal(goal) { this.goal = goal; if (goal) bot.emit('moving'); } },
    });
    const behavior = attachIdle(bot, {
        isIdle: () => true, isEnabled: () => true, setWalking() {}, log() {}, greetings: { last: 0, players: new Map() },
    });
    t.after(() => behavior.close());
    bot.emit('death');
    bot.entity.position = new Vec3(0,64,0);
    await once(bot, 'moving');
    assert.equal(behavior.status().type, 'return_to_death_site');
    assert.ok(bot.pathfinder.goal.isEnd(site));
    bot.entity.position = site.offset(-2,0,0);
    await once(bot, 'moving');
    assert.equal(behavior.status().type, 'collect_death_drops');
    assert.ok(bot.pathfinder.goal.isEnd(site));
});

test('status chat waits three minutes, ignores unchanged idle state, and respects the last post after reload', () => {
    let now = 1000, checkpoint;
    const lines = [];
    const state = { position: new Vec3(-1.25, 72, 5), health: 20, food: 18, items: [{ name: 'stone_pickaxe', count: 1 }],
        task: 'mine_gear', active: false, stage: 2 };
    const setup = () => createStatusTicker({ now: () => now, random: () => 0, read: () => state, checkpoint: () => checkpoint,
        record: value => { checkpoint = value; }, send: line => lines.push(line) });
    let tick = setup();
    now += 179_999; tick();
    assert.equal(lines.length, 0);
    now++; tick();
    assert.deepEqual(lines, ['[bot] (-2, 72, 5) | health 20/20, food 18/20 | stone_pickaxe | task: stage 2, mine gear']);
    tick = setup();
    state.active = true;
    now += 179_999; tick();
    assert.equal(lines.length, 1);
    now++; tick();
    assert.equal(lines.length, 2);
    state.active = false;
    now += 180_000; tick();
    assert.equal(lines.length, 2);
    state.food = 16;
    now += 180_000; tick();
    assert.equal(lines.length, 3);
});

test('status chat draws a new delay up to five minutes and honors the toggle without resetting the gap', () => {
    let now = 0, checkpoint, enabled = true;
    const delays = [0.5, 0.999999, 0];
    const posts = [];
    const tick = createStatusTicker({
        now: () => now, random: () => delays.shift(), enabled: () => enabled,
        checkpoint: () => checkpoint, record: value => { checkpoint = value; }, send: () => posts.push(now),
        read: () => ({ position: new Vec3(0, 70, 0), health: 20, food: 20, items: [], task: 'wander', active: true, stage: 2 }),
    });
    now = 239_999; tick();
    enabled = false;
    now++; tick();
    assert.deepEqual(posts, []);
    enabled = true;
    tick();
    now = 539_999; tick();
    assert.deepEqual(posts, [240_000]);
    now++; tick();
    assert.deepEqual(posts, [240_000, 540_000]);
});

test('food recovery hunts only eligible nearby livestock, equips a weapon, and collects meat', async () => {
    const position = new Vec3(0, 64, 0);
    const cow = { id: 2, name: 'cow', type: 'animal', position: position.offset(2, 0, 0) };
    const chicken = { id: 1, name: 'chicken', type: 'animal', position: position.offset(1, 0, 0) };
    const sheep = { id: 0, name: 'sheep', type: 'animal', position: position.offset(1, 0, 0) };
    const events = [];
    const bot = {
        entity: { position }, entities: { 0: sheep, 1: chicken, 2: cow }, players: {}, health: 9, food: 17,
        time: { timeOfDay: 15000 },
        registry: createRegistry('1.21.1'), world: { raycast(_eye, direction, distance) {
            assert.ok(Math.abs(direction.norm() - 1) < 1e-12);
            assert.ok(distance > 2);
            return null;
        } },
        inventory: { items: () => [{ name: 'wooden_sword' }, { name: 'iron_sword' }] },
        nearestEntity(predicate) { return Object.values(this.entities).find(predicate); },
        findBlock: () => null, blockAt: () => ({ name: 'air' }),
        pathfinder: { setGoal() {} }, clearControlStates() {},
        async equip(item) { events.push(item.name); this.heldItem = item; },
        async lookAt() {},
        attack(entity) {
            events.push(entity.name);
            delete this.entities[entity.id];
            this.entities[3] = { id: 3, position: entity.position, getDroppedItem: () => ({ name: 'beef' }) };
        },
    };
    let time = 0;
    const food = createFoodRecovery(bot, {
        setWalking() {}, isActive: () => true, change: plan => events.push(plan.type), now: () => time,
    });
    assert.equal(food.tick({ seek: true }), true);
    time += 1000;
    food.tick({ seek: true });
    await new Promise(setImmediate);
    time += 1000;
    food.tick({ seek: true });
    assert.deepEqual(events, ['hunt', 'iron_sword', 'cow', 'collect_food']);
    assert.equal(safeFood(bot, 'beef'), true);
    assert.equal(safeFood(bot, 'chicken'), false);
    food.stop();
});

test('food recovery cooks chicken in an empty furnace and picks up only its expected output', async () => {
    let time = 0, output, input;
    const position = new Vec3(0, 64, 0);
    const station = { name: 'furnace', position: position.offset(1, 0, 0) };
    const pack = [{ name: 'chicken', type: 1 }, { name: 'coal', type: 2 }];
    const events = [];
    const furnace = {
        inputItem: () => input, fuelItem: () => null, outputItem: () => output,
        async putInput(type) { input = { type }; events.push(['input', type]); pack.shift(); },
        async putFuel(type) { events.push(['fuel', type]); },
        async takeOutput() { events.push(['took', output.name]); output = undefined; },
        close() {},
    };
    const bot = {
        entity: { position }, players: {}, inventory: { items: () => pack },
        nearestEntity: () => null, findBlock: () => station, blockAt: () => station,
        async openFurnace() { return furnace; },
        pathfinder: { setGoal() {} }, clearControlStates() {},
    };
    const food = createFoodRecovery(bot, { setWalking() {}, isActive: () => true, change() {}, now: () => time });
    assert.equal(food.tick({ seek: true }), true);
    await new Promise(setImmediate);
    time = 11_000;
    input = undefined;
    output = { name: 'cooked_chicken' };
    assert.equal(food.tick({ seek: true }), true);
    await new Promise(setImmediate);
    assert.deepEqual(events, [['fuel', 2], ['input', 1], ['took', 'cooked_chicken']]);
});

test('food recovery picks ripe sweet berries without breaking the bush', async () => {
    const position = new Vec3(0, 64, 0);
    const makeBush = age => ({ name: 'sweet_berry_bush', position: position.offset(1, 0, 0), getProperties: () => ({ age }) });
    const bush = makeBush(3);
    const events = [];
    const bot = {
        entity: { position }, players: {}, health: 9, inventory: { items: () => [] },
        nearestEntity: () => null, findBlock({ matching, useExtraInfo }) {
            assert.equal(matching(makeBush(2)), false);
            assert.equal(matching({ ...bush, position: undefined }), true);
            return useExtraInfo(bush) ? bush : null;
        },
        blockAt: point => point.equals(bush.position) ? bush : { name: 'air' },
        canSeeBlock: () => true, async activateBlock(block) { events.push(block.name); },
        pathfinder: { setGoal() {} }, clearControlStates() {},
    };
    const food = createFoodRecovery(bot, { setWalking() {}, isActive: () => true, change: plan => events.push(plan.type) });
    assert.equal(food.tick({ seek: true }), true);
    food.tick({ seek: true });
    await new Promise(setImmediate);
    assert.deepEqual(events, ['harvest_food', 'sweet_berry_bush']);
});

test('resource-pack replies serialize the actual pack UUID on 1.21.1', () => {
    const serializer = createSerializer({ version: '1.21.1', state: states.CONFIGURATION, isServer: false });
    const expected = '12345678-1234-4356-8234-123456789abc';
    const objectUuid = new UUID(expected);
    class Client {
        replies = [];
        write(name, params) {
            const bytes = serializer.createPacketBuffer({ name, params });
            this.replies.push({ uuid: UUID.stringify(bytes.subarray(1, 17)), result: bytes[17] });
        }
    }
    const coldDaemon = new Client();
    acknowledgeResourcePack(coldDaemon, objectUuid);
    assert.deepEqual(coldDaemon.replies, [{ uuid: expected, result: 3 }, { uuid: expected, result: 0 }]);

    normalizeLegacyPackWrites(coldDaemon);
    const reconnect = new Client();
    reconnect.write('resource_pack_receive', { uuid: objectUuid, result: 3 });
    assert.deepEqual(reconnect.replies, [{ uuid: expected, result: 3 }]);
});

test('addressed player chat responds privately to whispers, ignores itself, and persists unanswered messages', async t => {
    const fixture = await mkdtemp(path.join(__dirname, 'test-chat-'));
    t.after(() => rm(fixture, { recursive: true, force: true }));
    const inboxPath = path.join(fixture, 'inbox.json');
    const inbox = createInbox(inboxPath);
    const metrics = { received: 0, ignoredSelf: 0, addressed: 0, responded: 0, queued: 0, failures: 0 };
    let now = 0;
    let ready = true;
    const bot = Object.assign(new EventEmitter(), {
        username: 'devincraftbot', players: { neighbor: {} },
        entity: { position: new Vec3(3.2, 61, -1.2) }, health: 19, food: 16,
        chat(message) { this.emit('reply', { message }); },
        whisper(to, message) { this.emit('reply', { to, message }); },
    });
    const commands = [];
    const detach = attachPlayerChat(bot, {
        isReady: () => ready, inbox, metrics, now: () => now,
        execute: async (...args) => { commands.push(args); return 'Done.'; },
    });
    const responses = [];
    bot.on('reply', response => responses.push(response));
    bot.emit('chat', 'devincraftbot', 'devincraftbot come');
    bot.emit('whisper', 'DevincraftBot', 'where are you');
    bot.emit('chat', 'neighbor', 'hello');
    bot.emit('chat', 'other', 'hello devincraftbot');
    assert.deepEqual(responses, []);
    bot.emit('chat', 'neighbor', 'Hello @devincraftbot!');
    bot.emit('whisper', 'neighbor', 'status');
    assert.deepEqual(responses, [{ message: 'neighbor: Hi, neighbor!' }]);

    now = 5000;
    bot.emit('whisper', 'neighbor', 'where are you');
    assert.deepEqual(responses.at(-1), { to: 'neighbor', message: "I'm at 3, 61, -2 with 19/20 health and 16/20 food." });
    now = 10000;
    const moved = once(bot, 'reply');
    bot.emit('chat', 'neighbor', 'devincraftbot follow me');
    await moved;
    assert.deepEqual(commands, [['follow', 'neighbor']]);
    const queued = once(bot, 'reply');
    now = 15000;
    bot.emit('whisper', 'neighbor', 'please save me some iron');
    await queued;
    assert.deepEqual(await createInbox(inboxPath).list(1), [{
        at: '1970-01-01T00:00:15.000Z', from: 'neighbor', whisper: true, message: 'please save me some iron',
    }]);
    assert.equal((await stat(inboxPath)).mode & 0o777, 0o600);
    ready = false;
    bot.emit('whisper', 'neighbor', 'help');
    detach();
    assert.equal(bot.listenerCount('chat'), 0);
    assert.deepEqual(metrics, { received: 8, ignoredSelf: 2, addressed: 5, responded: 4, queued: 1, failures: 0 });
});

test('reconnect backoff grows with jitter without retrying under 5s or over 5m', () => {
    assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7].map(attempt => retryDelayMs(attempt, () => 0.5)),
        [5500, 10000, 20000, 40000, 80000, 160000, 270000, 270000]);
    assert.equal(retryDelayMs(0, () => 0), 5000);
    assert.equal(retryDelayMs(0, () => 1), 6000);
    assert.equal(retryDelayMs(100, () => 0), 240000);
    assert.equal(retryDelayMs(100, () => 1), 300000);
});
