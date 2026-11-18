const { readFileSync } = require('node:fs');
const http = require('node:http');
const express = require('express');
const { Server } = require('socket.io');
const { setupRoutes } = require('prismarine-viewer/lib/common');

const [file] = process.argv.slice(2);
const [header, ...chunks] = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
if (!chunks.length) throw new Error('No chunks in scene snapshot');
const app = express();
setupRoutes(app);
const server = http.createServer(app);
const io = new Server(server);
io.on('connection', socket => {
    socket.emit('version', header.status.version);
    socket.emit('position', { pos: header.status.position, yaw: header.yaw, pitch: header.pitch, addMesh: false });
    for (const chunk of chunks) socket.emit('loadChunk', chunk);
});
server.listen(38719, '127.0.0.1', () => console.log('Snapshot viewer listening on http://127.0.0.1:38719/'));
