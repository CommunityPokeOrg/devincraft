import { writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';

const [filename, profile] = process.argv.slice(2);
const chrome = spawn('google-chrome', [
    '--headless=new', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage',
    '--no-first-run', '--remote-debugging-port=38720', `--user-data-dir=${profile}`,
    '--window-size=1280,900', 'http://127.0.0.1:38719/',
], { stdio: 'ignore' });
let socket;
try {
    let pages;
    for (let i = 0; i < 30; i++) {
        try { pages = await (await fetch('http://127.0.0.1:38720/json/list')).json(); break; }
        catch { await setTimeout(150); }
    }
    if (!pages?.length) throw new Error('Chrome did not expose a page');
    socket = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
        socket.addEventListener('open', resolve, { once: true });
        socket.addEventListener('error', reject, { once: true });
    });
    await setTimeout(10_000);
    const { data } = await new Promise((resolve, reject) => {
        socket.addEventListener('message', event => {
            const message = JSON.parse(event.data);
            if (message.error) reject(new Error(message.error.message));
            else resolve(message.result);
        }, { once: true });
        socket.send(JSON.stringify({ id: 1, method: 'Page.captureScreenshot', params: { format: 'png' } }));
    });
    await writeFile(filename, Buffer.from(data, 'base64'), { mode: 0o600 });
    console.log(`Saved ${filename}`);
} finally {
    socket?.close();
    chrome.kill();
}
