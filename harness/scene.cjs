const { once } = require('node:events');
const { setTimeout } = require('node:timers/promises');

async function sendScene(bot, status, response, connected) {
    if (response.req.headers.accept === 'application/vnd.ermsies.statusloop+json') {
        const mode = response.req.headers['x-ermsies-statusloop'];
        const goal = bot[Symbol.for('ermsies.diamond.goal')];
        const valid = mode === 'on' || mode === 'off';
        const result = valid && goal?.setStatusLoop(mode === 'on');
        response.writeHead(result ? 200 : valid ? 409 : 400, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        response.end(JSON.stringify(result ? { result } : { error: valid ? 'Status loop unavailable; reload behavior first.' : 'Use statusloop on or statusloop off.' }) + '\n');
        return;
    }
    if (response.req.headers.accept === 'application/vnd.ermsies.goal+json') {
        const result = bot[Symbol.for('ermsies.diamond.goal')]?.status();
        response.writeHead(result ? 200 : 409, { 'content-type': 'application/json' });
        response.end(JSON.stringify(result ? { result } : { error: 'Goal unavailable; reload behavior first.' }) + '\n');
        return;
    }
    status = { ...status, dimension: bot.game?.dimension ?? null };
    if (response.req.headers.accept === 'application/json') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ result: status }) + '\n');
        return;
    }
    const { position, yaw, pitch } = bot.entity;
    const cx = Math.floor(position.x / 16);
    const cz = Math.floor(position.z / 16);
    response.writeHead(200, { 'content-type': 'application/x-ndjson' });
    response.write(JSON.stringify({ at: new Date().toISOString(), status, yaw, pitch }) + '\n');
    for (let x = cx - 2; x <= cx + 2; x++) {
        for (let z = cz - 2; z <= cz + 2; z++) {
            if (response.destroyed || !connected()) return response.destroy();
            const column = bot.world.getColumn(x, z);
            if (column && !response.write(JSON.stringify({ x: x * 16, z: z * 16, chunk: column.toJson() }) + '\n')) {
                const abort = new AbortController();
                const closed = () => abort.abort();
                response.once('close', closed);
                try { await once(response, 'drain', { signal: abort.signal }); }
                finally { response.off('close', closed); }
            }
            await setTimeout(10);
        }
    }
    response.end();
}

module.exports = { sendScene };
