const { parentPort } = require('node:worker_threads');

function choose({ turn, sites, timber, nearby }) {
    const choices = {
        gather: timber && { type: timber.dropped ? 'collect' : 'gather', target: timber.position },
        follow: nearby && { type: 'follow', target: nearby },
        wander: sites.length && { type: 'wander', target: sites[Math.floor(Math.random() * sites.length)] },
    };
    const cycle = ['wander', 'gather', 'follow'];
    for (let step = 0; step < cycle.length; step++) {
        const index = (turn + step) % cycle.length;
        if (choices[cycle[index]]) return { ...choices[cycle[index]], next: (index + 1) % cycle.length };
    }
    return { type: 'idle', next: turn };
}

if (parentPort) parentPort.on('message', message => parentPort.postMessage({ id: message.id, ...choose(message) }));
module.exports = { choose };
