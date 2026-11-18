const { Session } = require('node:inspector/promises');
const { startControl } = require('./control.cjs');

const bridge = Symbol.for('devincraft-bot.attach');
if (globalThis[bridge]) throw new Error('The control socket is already installed.');
const session = new Session();
session.connect();
let current;
globalThis[bridge] = bot => { current = bot; };

const properties = objectId => session.post('Runtime.getProperties', { objectId, ownProperties: true });
async function getBot() {
    current = undefined;
    try {
        const { result: shutdown } = await session.post('Runtime.evaluate', {
            expression: "process.listeners('SIGTERM').find(listener => listener.name === 'shutdown')",
            objectGroup: 'devincraft-bot',
        });
        if (!shutdown.objectId) return undefined;
        const scopes = (await properties(shutdown.objectId)).internalProperties.find(property => property.name === '[[Scopes]]')?.value;
        if (!scopes) throw new Error('Could not find daemon module scopes.');
        const scope = (await properties(scopes.objectId)).result.find(property => property.value?.description === 'Module')?.value;
        if (!scope) throw new Error('Could not find daemon module scope.');
        const bot = (await properties(scope.objectId)).result.find(property => property.name === 'bot')?.value;
        if (bot?.objectId) {
            const call = await session.post('Runtime.callFunctionOn', {
                objectId: bot.objectId,
                functionDeclaration: "function () { globalThis[Symbol.for('devincraft-bot.attach')](this); }",
            });
            if (call.exceptionDetails) throw new Error('Could not obtain the live Minecraft bot.');
        }
        return current;
    } finally {
        current = undefined;
        await session.post('Runtime.releaseObjectGroup', { objectGroup: 'devincraft-bot' });
    }
}

const server = startControl({ getBot });
server.on('error', error => {
    console.error('Could not open local control socket:', error.message);
    server.close();
});
server.on('close', () => {
    session.disconnect();
    delete globalThis[bridge];
});
