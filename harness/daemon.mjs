import { appendFileSync, fstatSync, lstatSync, unlinkSync, writeFileSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { connect as tcpConnect } from 'node:net';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { createBot } from 'mineflayer';
import { pathfinder } from 'mineflayer-pathfinder';
import { plugin as pvp } from 'mineflayer-pvp';
import { installAsciiChat, throttleMovementPackets } from '../../src/body/bot.js';
import { installDamageTypes } from '../../src/body/hurt-cause.js';
import { isFatalKick, kickText } from '../../src/startup.js';
import { socketPath, startControl } from './control.cjs';
import { acknowledgeResourcePack } from './resource-pack.cjs';
import { retryDelayMs, STABLE_MS } from './reconnect.cjs';

const { values } = parseArgs({ options: { auth: { type: 'string' } } });
if (values.auth !== 'microsoft') throw new Error('Use --auth microsoft for the bot.');
process.umask(0o077);

const name = process.env.BOT_USERNAME;
if (!/^[a-z0-9_]{1,16}$/i.test(name ?? '')) throw new Error('Set BOT_USERNAME to the Minecraft profile name.');
const host = '15.204.152.101';
const port = 28556;
const version = '1.21.1';
const profilesFolder = new URL('./profiles', import.meta.url).pathname;
const logFile = new URL('./daemon.log', import.meta.url);
const stableFile = new URL('./supervisor-stable.pid', import.meta.url);
const lockFile = new URL('./supervisor.lock', import.meta.url);
const log = message => {
    const line = `[${new Date().toISOString()}] ${message}`;
    appendFileSync(logFile, line + '\n', { mode: 0o600 });
    console.log(line);
};

function hasSupervisorLockDescriptor() {
    try {
        const held = fstatSync(9);
        const expected = lstatSync(lockFile);
        return held.dev === expected.dev && held.ino === expected.ino;
    } catch {
        return false;
    }
}

if (!hasSupervisorLockDescriptor()) {
    console.error('Start the bot with supervise.sh so it holds the single-instance lock.');
    process.exit(78);
}

let bot;
let retry;
let attempts = 0;
let stopping = false;
await removeStaleControlSocket();
const control = startControl({
    getBot: () => bot,
    auto: true,
    log: message => {
        const line = `[${new Date().toISOString()}] ${message}`;
        void appendFile(logFile, line + '\n', { mode: 0o600 }).catch(() => console.error(line));
    },
});
control.once('listening', start);
control.on('error', error => {
    log(`Unable to open the private control socket: ${error.code ?? error.name}`);
    process.exitCode = error.code === 'EADDRINUSE' ? 78 : 1;
    shutdown();
});

async function removeStaleControlSocket() {
    try {
        if (!lstatSync(socketPath).isSocket()) return;
    } catch (error) {
        if (error.code === 'ENOENT') return;
        throw error;
    }
    await new Promise((resolve, reject) => {
        const probe = tcpConnect(socketPath);
        probe.once('connect', () => { probe.destroy(); resolve(); });
        probe.once('error', error => {
            try {
                if (error.code === 'ECONNREFUSED') unlinkSync(socketPath);
                else if (error.code !== 'ENOENT') throw error;
                resolve();
            } catch (cause) {
                reject(cause);
            }
        });
    });
}

function start() {
    log(`Starting ${name} (${values.auth}) for ${host}:${port}, Minecraft ${version}`);
    let spawnDeadline;
    let stableDeadline;
    let healthReport;
    let spawnedAt = 0;
    let lastInbound;
    let lastKeepalive;
    let eventLoopDelay;
    const age = timestamp => timestamp === undefined ? 'none' : `${Math.round(performance.now() - timestamp)}ms`;
    const diagnostics = () => `protocol=${current._client.state} lastPacket=${age(lastInbound)} lastKeepalive=${age(lastKeepalive)} maxEventLoopDelay=${Math.round(eventLoopDelay.max / 1e6)}ms`;
    const current = createBot({
        username: name,
        auth: values.auth,
        host,
        port,
        version,
        profilesFolder,
        hideErrors: true,
        checkTimeoutInterval: 60_000,
        onMsaCode({ verification_uri, user_code, expires_in }) {
            if (stopping || bot !== current) return;
            log('Microsoft device login is awaiting approval.');
            console.log(`Microsoft device authorization: ${verification_uri} — code ${user_code} (expires in ${expires_in}s)`);
        },
        connect(client) {
            if (stopping || bot !== current) return;
            if (client.username.toLowerCase() !== name.toLowerCase()) {
                log(`Microsoft authorization selected a different Minecraft profile. Not connecting as that account.`);
                shutdown();
                process.exitCode = 78;
                return;
            }
            log('Microsoft authorization returned the configured profile; connecting to Pokecraft.');
            const socket = tcpConnect(port, host);
            socket.setKeepAlive(true, 15_000);
            eventLoopDelay = monitorEventLoopDelay();
            eventLoopDelay.enable();
            client.on('packet', (_data, metadata) => {
                lastInbound = performance.now();
                if (metadata.name === 'keep_alive') lastKeepalive = lastInbound;
            });
            client.setSocket(socket);
            spawnDeadline = setTimeout(() => {
                if (current !== bot || stopping) return;
                log('No spawn within 45 seconds; reconnecting.');
                socket.destroy();
            }, 45_000);
        },
    });
    bot = current;
    installDamageTypes(current);
    throttleMovementPackets(current._client);
    current.loadPlugin(pathfinder);
    current.loadPlugin(pvp);
    current.once('inject_allowed', () => { current.pathfinder.tickTimeout = 15; });
    current.once('login', () => installAsciiChat(current));
    current.on('resourcePack', (_url, uuid) => acknowledgeResourcePack(current._client, uuid));
    current.on('spawn', () => {
        clearTimeout(spawnDeadline);
        if (!spawnedAt) {
            spawnedAt = performance.now();
            healthReport = setInterval(() => {
                log(`Connection health: ${diagnostics()}`);
                eventLoopDelay.reset();
            }, 60_000);
            healthReport.unref();
            stableDeadline = setTimeout(() => {
                if (current !== bot || stopping) return;
                try {
                    writeFileSync(stableFile, String(process.pid), { mode: 0o600 });
                } catch (error) {
                    log(`Could not record stable connection: ${error.code ?? error.name}`);
                }
            }, STABLE_MS);
            stableDeadline.unref();
        }
        log(`Spawned as ${current.username} in ${current.game.gameMode} mode.`);
    });
    let fatal = false;
    current.on('kicked', reason => {
        const message = kickText(reason);
        fatal = isFatalKick(message);
        log(`Kicked: ${message}`);
    });
    current.on('error', error => {
        if (/^client timed out after \d+ milliseconds$/.test(error.message ?? '')) {
            log(`Minecraft keepalive: ${error.message}; closing the unresponsive socket.`);
            queueMicrotask(() => current._client.socket?.destroy());
        } else {
            log(`Connection/authentication error: ${error.code ?? error.name ?? 'Error'}`);
        }
        if (!current._client.socket && current === bot && !stopping) reconnect(current);
    });
    current.once('end', reason => {
        clearTimeout(spawnDeadline);
        clearTimeout(stableDeadline);
        clearInterval(healthReport);
        eventLoopDelay?.disable();
        log(`Disconnected: ${reason}`);
        if (eventLoopDelay) {
            log(`Connection diagnostics: ${diagnostics()}`);
        }
        if (current !== bot || stopping) return;
        if (fatal) {
            log('Not retrying a permanent kick.');
            process.exitCode = 78;
            shutdown();
        } else {
            if (spawnedAt && performance.now() - spawnedAt >= STABLE_MS) attempts = 0;
            reconnect(current);
        }
    });
}

function reconnect(current) {
    if (current !== bot || stopping) return;
    bot = undefined;
    const delay = retryDelayMs(attempts++);
    log(`Reconnecting in ${(delay / 1000).toFixed(3)}s (attempt ${attempts}).`);
    retry = setTimeout(start, delay);
}

function shutdown() {
    if (stopping) return;
    stopping = true;
    clearTimeout(retry);
    control.close();
    if (bot?._client.socket) bot.quit();
}

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
process.on('uncaughtExceptionMonitor', error => {
    const frames = error.stack?.split('\n').filter(line => /^\s+at /.test(line)).join('\n');
    try {
        log(`Uncaught ${error.name ?? 'Error'}${frames ? '\n' + frames : ''}`);
    } catch {
        // The default exception handler will still write the stack to the tmux pane.
    }
});
