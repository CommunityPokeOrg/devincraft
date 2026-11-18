const uuidString = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const marker = Symbol('resource-pack-write');

function acknowledgeResourcePack(client, id) {
    const uuid = String(id);
    if (!uuidString.test(uuid)) throw new Error('Received an invalid resource pack UUID.');
    client.write('resource_pack_receive', { uuid, result: 3 });
    client.write('resource_pack_receive', { uuid, result: 0 });
}

function normalizeLegacyPackWrites(client) {
    const prototype = Object.getPrototypeOf(client);
    if (prototype[marker]) return;
    const write = prototype.write;
    prototype.write = function (name, params, ...rest) {
        if (name === 'resource_pack_receive' && params?.uuid && typeof params.uuid === 'object') {
            const uuid = String(params.uuid);
            if (uuidString.test(uuid)) return write.call(this, name, { ...params, uuid }, ...rest);
        }
        return write.call(this, name, params, ...rest);
    };
    Object.defineProperty(prototype, marker, { value: true });
}

module.exports = { acknowledgeResourcePack, normalizeLegacyPackWrites };
