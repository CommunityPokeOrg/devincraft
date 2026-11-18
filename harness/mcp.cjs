const { createInterface } = require('node:readline');
const { call } = require('./client.cjs');

const types = {
    string: { type: 'string' },
    integer: { type: 'integer' },
    number: { type: 'number' },
};
const coords = { x: types.integer, y: types.integer, z: types.integer };
const definitions = [
    ['status', 'Get bot state, position, health, inventory, and nearby entities.', {}],
    ['goal', 'Get the gear progression, missing gear, diamond counts, and deaths.', {}],
    ['say', 'Send one ordinary chat message, not a server command.', { message: types.string }],
    ['whisper', 'Send a private in-game message.', { player: types.string, message: types.string }],
    ['chat', 'Read recent Minecraft chat.', { limit: { type: 'integer', minimum: 1, maximum: 100 } }, []],
    ['inbox', 'Read stored addressed player messages the bot could not handle.', { limit: { type: 'integer', minimum: 1, maximum: 100 } }, []],
    ['auto', 'Enable or disable autonomous idle behavior.', { mode: { type: 'string', enum: ['on', 'off'] } }],
    ['statusloop', 'Enable or disable periodic progress chat.', { mode: { type: 'string', enum: ['on', 'off'] } }],
    ['reload', 'Reload behavior and control handlers without reconnecting to Minecraft.', {}],
    ['goto', 'Start walking to block coordinates.', coords],
    ['follow', 'Follow a visible player.', { player: types.string }],
    ['look', 'Turn to the given yaw and pitch in degrees.', { yaw: types.number, pitch: types.number }],
    ['dig', 'Dig a block within reach.', coords],
    ['place', 'Place the held block against the supplied reference block and face.', {
        ...coords, face: { type: 'string', enum: ['up', 'down', 'north', 'south', 'west', 'east'] },
    }],
    ['equip', 'Equip a named inventory item in the main hand.', { item: types.string }],
    ['attack', 'Make one melee attack on the entity ID or player within reach.', { target: types.string }],
    ['stop', 'Stop walking and digging.', {}],
];
const tools = definitions.map(([name, description, properties, required = Object.keys(properties)]) => ({
    name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false },
}));
const allowedProtocols = new Set(['2024-11-05', '2025-03-26', '2025-06-18']);
const send = payload => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...payload }) + '\n');
const error = (id, code, message) => send({ id, error: { code, message } });

async function handle(line) {
    let message;
    try { message = JSON.parse(line); } catch { return error(null, -32700, 'Parse error'); }
    if (message?.jsonrpc !== '2.0' || typeof message.method !== 'string') return error(message?.id ?? null, -32600, 'Invalid request');
    if (!Object.hasOwn(message, 'id')) return;
    const { id, method, params } = message;
    const reply = result => send({ id, result });
    if (method === 'initialize') return reply({
        protocolVersion: allowedProtocols.has(params?.protocolVersion) ? params.protocolVersion : '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'devincraft-bot', version: '1.0.0' },
    });
    if (method === 'ping') return reply({});
    if (method === 'tools/list') return reply({ tools });
    if (method !== 'tools/call') return error(id, -32601, 'Method not found');
    const tool = tools.find(tool => tool.name === params?.name);
    const values = params?.arguments ?? {};
    if (!tool || typeof values !== 'object' || Array.isArray(values)) return error(id, -32602, 'Invalid tool or arguments');
    const { properties, required } = tool.inputSchema;
    if (required.some(name => !Object.hasOwn(values, name))
        || Object.entries(values).some(([name, value]) => !Object.hasOwn(properties, name)
            || !matches(properties[name], value))) return error(id, -32602, 'Invalid tool arguments');
    try {
        const args = Object.keys(properties).filter(name => Object.hasOwn(values, name)).map(name => String(values[name]));
        const result = await call(tool.name, args);
        reply({ content: [{ type: 'text', text: JSON.stringify(result) }] });
    } catch (cause) {
        reply({ content: [{ type: 'text', text: cause.message }], isError: true });
    }
}

function matches(schema, value) {
    if (schema.type === 'string') return typeof value === 'string' && (!schema.enum || schema.enum.includes(value));
    if (schema.type === 'number') return Number.isFinite(value);
    return Number.isSafeInteger(value) && value >= (schema.minimum ?? -Infinity) && value <= (schema.maximum ?? Infinity);
}

createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => { if (line.trim()) void handle(line); });
