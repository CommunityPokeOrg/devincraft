const { readFile, rename, writeFile } = require('node:fs/promises');

function createInbox(path) {
    let pending = Promise.resolve();
    const read = async () => {
        try {
            return JSON.parse(await readFile(path, 'utf8'));
        } catch (error) {
            if (error.code === 'ENOENT') return [];
            throw error;
        }
    };
    return {
        async list(limit) {
            await pending;
            return (await read()).slice(-limit);
        },
        add(entry) {
            const update = pending.then(async () => {
                const records = (await read()).concat(entry).slice(-100);
                const temporary = path + '.tmp';
                await writeFile(temporary, JSON.stringify(records) + '\n', { mode: 0o600 });
                await rename(temporary, path);
            });
            pending = update.catch(() => {});
            return update;
        },
    };
}

function attachPlayerChat(bot, { isReady, execute, inbox, metrics, now = Date.now }) {
    const cooldownMs = 4000;
    const replies = new Map();
    const name = bot.username ?? bot._client?.authflow?.username ?? 'ermsies';
    const address = new RegExp(`(?<![a-z0-9_])@?${name}(?![a-z0-9_])`, 'i');
    let detached = false;

    async function receive(sender, message, whisper) {
        if (detached || !isReady() || typeof sender !== 'string' || !/^[a-z0-9_]{1,16}$/i.test(sender)) return;
        if (sender.toLowerCase() === name.toLowerCase()) {
            metrics.received++;
            metrics.ignoredSelf++;
            return;
        }
        if (!bot.players || !Object.hasOwn(bot.players, sender) || typeof message !== 'string') return;
        metrics.received++;
        if (!whisper && !address.test(message)) return;
        metrics.addressed++;
        const text = message.replace(address, '').replace(/^[\s,.:!?-]+|[\s,.:!?-]+$/g, '').toLowerCase();
        const at = now();
        let response;
        let command;
        if (/^(hi|hey|hello|hiya|good morning|good evening)( there)?$/.test(text)) response = `Hi, ${sender}!`;
        else if (/^(help|commands|what can you do)$/.test(text)) response = 'Try: ermsies status, where are you, follow me, or stop.';
        else if (/^(where are you|where|coords|position|status)$/.test(text)) {
            const { x, y, z } = bot.entity.position;
            response = `I'm at ${Math.floor(x)}, ${Math.floor(y)}, ${Math.floor(z)} with ${bot.health}/20 health and ${bot.food}/20 food.`;
        } else if (/^(come|come here|follow|follow me)$/.test(text)) command = 'follow';
        else if (/^stop( following( me)?)?$/.test(text)) command = 'stop';
        else {
            await inbox.add({ at: new Date(at).toISOString(), from: sender, whisper, message: message.slice(0, 256) });
            metrics.queued++;
            response = 'I put that in my inbox. Say ermsies help for commands I can answer right now.';
        }

        if (detached || !isReady()) return;
        for (const [player, timestamp] of replies) {
            if (at - timestamp >= cooldownMs) replies.delete(player);
        }
        const key = sender.toLowerCase();
        if (replies.has(key)) return;
        replies.set(key, at);
        if (command) response = await execute(command, sender);
        if (detached || !isReady()) return;
        if (whisper) bot.whisper(sender, response);
        else bot.chat(`${sender}: ${response}`);
        metrics.responded++;
    }

    const listen = whisper => (sender, message) => {
        void receive(sender, message, whisper).catch(error => {
            metrics.failures++;
            console.error('Player chat handling failed:', error.code ?? error.name);
        });
    };
    const chat = listen(false);
    const whisper = listen(true);
    bot.on('chat', chat);
    bot.on('whisper', whisper);
    return () => {
        detached = true;
        bot.off('chat', chat);
        bot.off('whisper', whisper);
    };
}

module.exports = { attachPlayerChat, createInbox };
