const { Session } = require('node:inspector/promises');
const { setTimeout: sleep } = require('node:timers/promises');
const { acknowledgeResourcePack, normalizeLegacyPackWrites } = require('./resource-pack.cjs');

module.exports = async function diagnose(mode) {
    const session = new Session();
    session.connect();
    const get = async id => session.post('Runtime.getProperties', { objectId: id, ownProperties: true });
    const bridge = Symbol.for('ermsies-direct.diagnose');
    let bot;
    let packs;
    globalThis[bridge] = received => { bot = received; };
    try {
        const { result } = await session.post('Runtime.evaluate', { expression: "process.listeners('SIGTERM').find(f=>f.name==='shutdown')" });
        const scopes = (await get(result.objectId)).internalProperties.find(x => x.name === '[[Scopes]]').value;
        const scope = (await get(scopes.objectId)).result.find(x => x.value?.description === 'Module').value;
        const value = (await get(scope.objectId)).result.find(x => x.name === 'bot').value;
        if (value.objectId) await session.post('Runtime.callFunctionOn', {
            objectId: value.objectId,
            functionDeclaration: "function(){globalThis[Symbol.for('ermsies-direct.diagnose')](this)}",
        });
        const packFunction = (await get(value.objectId)).result.find(x => x.name === 'acceptResourcePack').value;
        const packScopes = (await get(packFunction.objectId)).internalProperties.find(x => x.name === '[[Scopes]]').value;
        const packScope = (await get(packScopes.objectId)).result.find(x => x.value?.description === 'Closure (inject)').value;
        const packMap = (await get(packScope.objectId)).result.find(x => x.name === 'activeResourcePacks').value;
        packs = (await get(packMap.objectId)).result.map(x => x.name);
    } finally {
        delete globalThis[bridge];
        session.disconnect();
    }
    if (!bot) return { bot: false };
    const client = bot._client;
    if (mode === 'stabilize') {
        normalizeLegacyPackWrites(client);
        return { state: client.state, reconnectResourcePackUuidNormalization: true };
    }
    const received = {};
    const errors = [];
    const collect = (_packet, metadata) => {
        const key = `${metadata.state}:${metadata.name}`;
        received[key] = (received[key] ?? 0) + 1;
    };
    const recordError = err => errors.push(String(err.message).split(':')[0].slice(0, 100));
    const snapshot = () => ({
        state: client.state, encrypted: Boolean(client.cipher), bytesRead: client.socket?.bytesRead,
        bytesWritten: client.socket?.bytesWritten, finishedConfig: !client.listenerCount('finish_configuration'),
        loginPacketHandled: !client.listeners('login').some(fn => fn.name === '' && fn.toString().includes('enforcesSecureChat')),
        position: Boolean(bot.entity?.position), health: bot.health, gameMode: bot.game?.gameMode,
        ownEntityId: bot.entity?.id, entityCount: Object.keys(bot.entities ?? {}).length,
        updateHealthListeners: client.listenerCount('update_health'), resourcePackListeners: bot.listenerCount('resourcePack'),
        bundleBufferSize: client._mcBundle?.length, resourcePackDetailsStored: Boolean(bot.resourcePack),
    });
    const before = snapshot();
    client.on('packet', collect);
    client.on('error', recordError);
    if (mode === 'repair') {
        if (client.state !== 'configuration' || packs.length !== 1 || !/^[0-9a-f-]{36}$/.test(packs[0]))
            throw new Error('Cannot safely repair the resource-pack acknowledgement in this state.');
        acknowledgeResourcePack(client, packs[0]);
    }
    await sleep(5000);
    client.off('packet', collect);
    client.off('error', recordError);
    return { before, after: snapshot(), received, errors, packCount: packs.length, repaired: mode === 'repair' };
};
