const { readFileSync, readlinkSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { pathToFileURL } = require('node:url');

async function main() {
    const [, , pid, mode = 'attach'] = process.argv;
    if (!['attach', 'diagnose', 'repair', 'stabilize'].includes(mode)) throw new Error('Use attach, diagnose, repair, or stabilize.');
    const expected = join(__dirname, 'daemon.mjs');
    if (!/^\d+$/.test(pid ?? '')) throw new Error('Pass the PID of the existing bot daemon.');
    const [, script] = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
    if (!script || resolve(readlinkSync(`/proc/${pid}/cwd`), script) !== expected)
        throw new Error('Pass the PID of the existing bot daemon.');
    const endpoint = 'http://127.0.0.1:9229/json/list';
    const discover = () => fetch(endpoint, { signal: AbortSignal.timeout(500) });
    const existing = await discover().catch(() => null);
    if (existing) throw new Error('Refusing to use an already-listening inspector.');
    process.kill(Number(pid), 'SIGUSR1');
    let targets;
    for (let attempt = 0; attempt < 15; attempt++) {
        const response = await discover().catch(() => null);
        if (response?.ok) {
            targets = await response.json();
            break;
        }
        await delay(100);
    }
    const [target] = targets ?? [];
    if (targets?.length !== 1 || target.url !== pathToFileURL(expected).href)
        throw new Error('The newly opened inspector does not identify the bot daemon.');
    const url = new URL(target.webSocketDebuggerUrl);
    if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || url.port !== '9229')
        throw new Error('Unexpected inspector endpoint.');
    const ws = new WebSocket(url);
    const timeout = setTimeout(() => {
        ws.close();
        console.error('Timed out attaching the control socket.');
        process.exitCode = 1;
    }, mode !== 'attach' ? 12_000 : 4000);
    ws.addEventListener('open', () => {
        const attachment = JSON.stringify(join(__dirname, mode !== 'attach' ? 'diagnose-live.cjs' : 'attach.cjs'));
        ws.send(JSON.stringify({
            id: 1,
            method: 'Runtime.evaluate',
            params: {
                expression: `(() => {
                    const inspector = process.getBuiltinModule('node:inspector');
                    setTimeout(() => inspector.close(), ${['diagnose', 'repair'].includes(mode) ? 6500 : 1500}).unref();
                    const load = process.getBuiltinModule('node:module').createRequire(${attachment});
                    ${mode !== 'attach' ? `delete load.cache[load.resolve(${attachment})];` : ''}
                    const loaded = load(${attachment});
                    return ${mode !== 'attach' ? `loaded(${JSON.stringify(mode)})` : 'process.pid'};
                })()`,
                returnByValue: true,
                awaitPromise: mode !== 'attach',
            },
        }));
    });
    ws.addEventListener('message', event => {
        const response = JSON.parse(event.data);
        if (response.id !== 1) return;
        if (response.error || response.result?.exceptionDetails || (mode === 'attach' && response.result?.result?.value !== Number(pid))) {
            console.error('Live attachment failed:', response.result?.exceptionDetails?.exception?.description ?? response.error);
            process.exitCode = 1;
        } else if (mode === 'attach') {
            console.log(`Control module attached to existing daemon PID ${pid}.`);
        } else {
            console.log(JSON.stringify(response.result.result.value, null, 2));
        }
        ws.close();
    });
    ws.addEventListener('close', () => clearTimeout(timeout));
    ws.addEventListener('error', () => {
        console.error('Could not connect to the local inspector.');
        process.exitCode = 1;
        clearTimeout(timeout);
    });
}

main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
});
