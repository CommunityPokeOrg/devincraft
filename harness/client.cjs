const http = require('node:http');
const path = require('node:path');

async function call(command, args, socketPath = path.join(__dirname, 'control.sock')) {
    if (command === 'status' && args.length === 0) {
        const result = await requestJson(socketPath, 'application/json');
        if (result) return result;
    }
    if (command === 'goal') {
        if (args.length) throw new Error('Wrong argument count for goal.');
        const result = await requestJson(socketPath, 'application/vnd.devincraft.goal+json');
        if (!result) throw new Error('Goal unavailable; the bot may be disconnected or capturing a scene.');
        return result;
    }
    if (command === 'statusloop') {
        if (args.length !== 1 || !['on', 'off'].includes(args[0])) throw new Error('Use statusloop on or statusloop off.');
        const result = await requestJson(socketPath, 'application/vnd.devincraft.statusloop+json', null, { 'x-devincraft-statusloop': args[0] });
        if (!result) throw new Error('Status loop unavailable; the bot may be disconnected or capturing a scene.');
        return result;
    }
    return requestJson(socketPath, null, { command, args });
}

function requestJson(socketPath, scene, command, sceneHeaders) {
    return new Promise((resolve, reject) => {
        const request = http.request({
            socketPath, method: scene ? 'GET' : 'POST', path: scene ? '/scene' : '/command',
            headers: scene ? { accept: scene, ...sceneHeaders } : { 'content-type': 'application/json' },
            timeout: 17_000,
        }, async response => {
            if (scene && (response.statusCode !== 200 || response.headers['content-type'] !== 'application/json')) {
                resolve(null);
                response.destroy();
                return;
            }
            try {
                let body = '';
                for await (const chunk of response.setEncoding('utf8')) body += chunk;
                const { result, error } = JSON.parse(body);
                if (error) throw new Error(error);
                resolve(result);
            } catch (error) {
                reject(error);
            }
        });
        request.once('timeout', () => request.destroy(new Error('Control request timed out.')));
        request.once('error', error => reject(error.code === 'ENOENT' || error.code === 'ECONNREFUSED'
            ? new Error('The daemon control socket is not available.') : error));
        request.end(command && JSON.stringify(command));
    });
}

module.exports = { call };
