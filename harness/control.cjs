const { createServer } = require('node:http');
const path = require('node:path');
const Vec3 = require('vec3');
const { Movements } = require('mineflayer-pathfinder');
const { createInbox } = require('./player-chat.cjs');

const socketPath = path.join(__dirname, 'control.sock');
const maxBody = 4096;
const commands = {
    status: 0, say: 1, whisper: 2, chat: (n) => n <= 1, inbox: (n) => n <= 1, goto: 3, follow: 1, look: 2,
    dig: 3, place: 4, equip: 1, attack: 1, stop: 0, auto: 1, step: 2, pillar: 1, reload: 0,
};
const reloadable = {
    './idle-planner.cjs': 'choose', './food-recovery.cjs': 'createFoodRecovery',
    './idle-behavior.cjs': 'attachIdle', './scene.cjs': 'sendScene',
    './player-chat.cjs': 'attachPlayerChat', './control-actions.cjs': 'runGameplay',
};

function loadModules(reload = false) {
    const entries = Object.entries(reloadable);
    const saved = entries.map(([file]) => require.cache[require.resolve(file)]);
    const children = module.children.slice();
    if (reload) for (const [file] of entries) delete require.cache[require.resolve(file)];
    try {
        const modules = Object.fromEntries(entries.map(([file, name]) => [name, require(file)[name]]));
        for (const [name, fn] of Object.entries(modules)) {
            if (typeof fn !== 'function') throw new TypeError(`Missing handler: ${name}`);
        }
        if (reload) module.children = module.children.filter(child => !saved.includes(child));
        return modules;
    } catch (error) {
        if (reload) {
            entries.forEach(([file], index) => {
                const id = require.resolve(file);
                if (saved[index]) require.cache[id] = saved[index];
                else delete require.cache[id];
            });
            module.children = children;
        }
        throw error;
    }
}

class CommandError extends Error {}
function integer(value, min, max) {
    const number = Number(value);
    if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(number) || number < min || number > max)
        throw new CommandError(`Expected an integer from ${min} to ${max}.`);
    return number;
}
const position = ([x, y, z]) => new Vec3(integer(x, -30000000, 30000000), integer(y, -2048, 2048), integer(z, -30000000, 30000000));
const describePosition = ({ x, y, z }) => ({ x, y, z });
const describeItem = ({ name, count, slot }) => ({ name, count, slot });

function startControl({ getBot, path: listenPath = socketPath, inboxPath = path.join(__dirname, 'inbox.json'), auto = false, log = console.log }) {
    let bot;
    let detach;
    let ready = false;
    let state = 'waiting_for_microsoft';
    let action = null;
    let chatOwner;
    let connectedOnce = false;
    let activeCommand = null;
    let refreshPending;
    let idle;
    let detachResponder;
    let capturing = false;
    let modules = loadModules();
    const greetings = { last: 0, players: new Map() };
    const chat = [];
    const inbox = createInbox(inboxPath);
    const metrics = { received: 0, ignoredSelf: 0, addressed: 0, responded: 0, queued: 0, failures: 0 };
    function setAction(next, owner) {
        chatOwner = owner;
        action = next;
        return action;
    }
    function attachHandlers(watching, handlers) {
        const behavior = handlers.attachIdle(watching, {
            isEnabled: () => auto,
            isIdle: () => bot === watching && ready && !action && !activeCommand,
            setWalking: current => setWalkingMovements(current, true),
            log, greetings,
        });
        let responder;
        try {
            responder = handlers.attachPlayerChat(watching, {
                isReady: () => bot === watching && ready,
                inbox,
                metrics,
                async execute(command, sender) {
                    try {
                        await run(command, command === 'follow' ? [sender] : [], sender);
                        return command === 'follow' ? 'I will follow you.' : 'I stopped following.';
                    } catch (error) {
                        if (!(error instanceof CommandError)) throw error;
                        return error.message;
                    }
                },
            });
        } catch (error) {
            behavior.close();
            throw error;
        }
        idle?.close();
        detachResponder?.();
        idle = behavior;
        detachResponder = responder;
    }
    const refresh = () => {
        if (refreshPending) return refreshPending;
        refreshPending = Promise.resolve().then(getBot).then(next => {
            if (next === bot) return;
            detach?.();
            bot = next;
            action = null;
            chatOwner = undefined;
            ready = Boolean(bot?.entity?.position && bot?.game?.gameMode);
            if (ready) connectedOnce = true;
            state = ready ? 'spawned' : bot?._client?.socket ? 'connecting' : connectedOnce ? 'reconnecting' : 'waiting_for_microsoft';
            if (!bot) return;
            const watching = bot;
            attachHandlers(watching, modules);
            const handlers = {
                spawn() { ready = true; connectedOnce = true; state = 'spawned'; },
                end() { ready = false; state = 'disconnected'; action = null; idle?.cancel(); },
                death() { idle?.cancel(5000); },
                messagestr(message, position) {
                    chat.push({ at: new Date().toISOString(), position, message: String(message).slice(0, 512) });
                    if (chat.length > 100) chat.shift();
                },
                goal_reached() { if (action?.type === 'goto') action = null; },
                path_update(result) { if (action) action = { ...action, pathStatus: result.status }; },
            };
            for (const [event, listener] of Object.entries(handlers)) watching.on(event, listener);
            detach = () => {
                idle?.close();
                idle = undefined;
                detachResponder?.();
                detachResponder = undefined;
                for (const [event, listener] of Object.entries(handlers)) watching.off(event, listener);
            };
        }).finally(() => { refreshPending = undefined; });
        return refreshPending;
    };
    const timer = setInterval(() => refresh().catch(error => console.error('Control bot lookup:', error.message)), 1000);
    timer.unref();

    function status() {
        if (!ready) return { state: bot?._client?.socket && state === 'waiting_for_microsoft' ? 'connecting' : state };
        const local = bot.entity.position;
        const entities = Object.values(bot.entities).filter(e => e !== bot.entity && e.position && e.position.distanceTo(local) <= 32)
            .sort((a, b) => a.position.distanceTo(local) - b.position.distanceTo(local)).slice(0, 50)
            .map(({ id, name, type, username, position: pos }) => ({ id, name, type, username, position: describePosition(pos) }));
        return {
            state, username: bot.username, version: bot.version, gameMode: bot.game.gameMode, dimension: bot.game.dimension ?? null,
            position: describePosition(local), health: bot.health, food: bot.food, action, chatHandler: { ...metrics },
            autonomous: { enabled: auto, behavior: idle?.status() ?? { type: 'idle' } },
            heldItem: bot.heldItem ? describeItem(bot.heldItem) : null,
            inventory: bot.inventory.items().map(describeItem),
            players: Object.keys(bot.players).filter(name => name !== bot.username),
            nearbyEntities: entities,
        };
    }

    async function run(command, args, sender) {
        const arity = Object.hasOwn(commands, command) ? commands[command] : undefined;
        if (arity === undefined) throw new CommandError('Unknown command.');
        if (typeof arity === 'function' ? !arity(args.length) : arity !== args.length)
            throw new CommandError(`Wrong argument count for ${command}.`);
        await refresh();
        if (command === 'status') return status();
        if (command === 'chat') return chat.slice(-integer(args[0] ?? '20', 1, 100));
        if (command === 'inbox') return inbox.list(integer(args[0] ?? '20', 1, 100));
        if (command === 'reload') {
            if (activeCommand) throw new CommandError(`Another command is running: ${activeCommand}.`);
            try {
                const updated = loadModules(true);
                if (bot) attachHandlers(bot, updated);
                modules = updated;
            } catch (error) {
                log(`Handler reload failed: ${error.code ?? error.name}`);
                throw new CommandError('Reload failed; previous handlers remain active.');
            }
            log('Behavior and control handlers reloaded.');
            return { reloaded: true, state: status().state };
        }
        if (command === 'auto') {
            if (!['on', 'off'].includes(args[0])) throw new CommandError('Use auto on or auto off.');
            auto = args[0] === 'on';
            if (!auto) idle?.cancel();
            return { enabled: auto };
        }
        if (!ready) throw new CommandError(`Bot is not ready (${status().state}).`);
        const current = bot;
        if (sender && command === 'follow' && (action || activeCommand))
            throw new CommandError("I'm busy right now.");
        if (sender && command === 'stop' && (chatOwner !== sender || action?.type !== 'follow' || activeCommand))
            throw new CommandError("I'm not following you.");
        idle?.cancel(5000);
        if (command === 'stop') {
            current.pvp.stop();
            current.pathfinder.setGoal(null);
            current.stopDigging();
            current.clearControlStates();
            action = null;
            chatOwner = undefined;
            return { stopped: true };
        }
        if (activeCommand) throw new CommandError(`Another command is running: ${activeCommand}.`);
        activeCommand = command;
        try {
            return await modules.runGameplay(command, args, {
                current, sender, setAction, CommandError, position, integer, describePosition, setWalkingMovements, chatText,
            });
        } finally {
            activeCommand = null;
        }
    }

    const server = createServer(async (request, response) => {
        const reply = (code, data) => {
            response.writeHead(code, { 'content-type': 'application/json' });
            response.end(JSON.stringify(data) + '\n');
        };
        if (request.method === 'GET' && request.url === '/scene') {
            try {
                await refresh();
                if (!ready || !bot.world || capturing) return reply(409, { error: 'Scene unavailable or already being captured.' });
                capturing = true;
                const current = bot;
                try {
                    await modules.sendScene(current, status(), response, () => ready && bot === current);
                } finally {
                    capturing = false;
                }
            } catch {
                if (!response.headersSent) reply(500, { error: 'Scene capture failed.' });
                else response.destroy();
            }
            return;
        }
        if (request.method !== 'POST' || request.url !== '/command' || request.headers['content-type'] !== 'application/json') {
            reply(404, { error: 'Use POST /command with application/json.' });
            return;
        }
        try {
            let body = '';
            for await (const chunk of request.setEncoding('utf8')) {
                body += chunk;
                if (Buffer.byteLength(body) > maxBody) {
                    return reply(413, { error: 'Request too large.' });
                }
            }
            let input;
            try { input = JSON.parse(body); } catch { throw new CommandError('Invalid JSON.'); }
            if (typeof input?.command !== 'string' || !Array.isArray(input.args) || input.args.some(arg => typeof arg !== 'string'))
                throw new CommandError('Expected a command and an array of string arguments.');
            reply(200, { result: await run(input.command, input.args) });
        } catch (error) {
            if (error instanceof CommandError) reply(400, { error: error.message });
            else {
                console.error('Control command failed:', error.message);
                reply(500, { error: 'Minecraft command failed. See the daemon console.' });
            }
        }
    });
    server.requestTimeout = 15_000;
    server.setTimeout(15_000, connection => connection.destroy());
    server.on('close', () => {
        clearInterval(timer);
        detach?.();
    });
    server.listen(listenPath);
    server.unref();
    return server;
}

function chatText(value) {
    const message = value.trim();
    if (!message || message.length > 256 || /[\u0000-\u001f\u007f]/.test(message) || message.startsWith('/'))
        throw new CommandError('Use a single non-command chat message of 1–256 characters.');
    return message;
}

function setWalkingMovements(bot, cautious = false) {
    const movement = new Movements(bot);
    movement.canDig = false;
    movement.allow1by1towers = false;
    movement.scafoldingBlocks = [];
    if (cautious) {
        movement.allowSprinting = false;
        movement.allowParkour = false;
        movement.maxDropDown = 1;
        for (const name of ['water', 'lava', 'campfire', 'soul_campfire', 'powder_snow', 'magma_block'])
            if (bot.registry.blocksByName[name]) movement.blocksToAvoid.add(bot.registry.blocksByName[name].id);
    }
    bot.pathfinder.setMovements(movement);
}

module.exports = { startControl, socketPath };
