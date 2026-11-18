const minInterval = 180_000;
const maxInterval = 300_000;
const priority = [/pickaxe$/, /sword$/, /^diamond$/, /^(?:raw_iron|iron_ingot)$/, /^(?:cobblestone|cobbled_deepslate)$/, /^furnace$/, /_(?:log|planks)$/, /^(?:apple|bread|cooked_.*)$/];

function highlight(items) {
    const counts = new Map();
    for (const { name, count } of items) counts.set(name, (counts.get(name) ?? 0) + count);
    const ranked = [...counts].sort(([a], [b]) => {
        const rank = name => priority.findIndex(pattern => pattern.test(name)) + 1 || priority.length + 1;
        return rank(a) - rank(b) || a.localeCompare(b);
    });
    return ranked.slice(0, 3).map(([name, count]) => count === 1 ? name : `${count} ${name}`).join(', ') || 'empty inventory';
}

function createStatusTicker({ read, checkpoint, record, send, enabled = () => true, now = Date.now, random = Math.random }) {
    const started = now();
    const delay = () => minInterval + Math.floor(random() * (maxInterval - minInterval + 1));
    let next;
    return () => {
        if (!enabled()) return;
        const time = now(), last = checkpoint();
        next ??= (last?.at ?? started) + delay();
        if (time < next || (last && time - last.at < minInterval)) return;
        const state = read();
        if (!state) return;
        next = time + delay();
        const { x, y, z } = state.position;
        const items = highlight(state.items);
        const task = state.task.replace(/_/g, ' ');
        const signature = JSON.stringify([Math.floor(x / 8), Math.floor(y / 4), Math.floor(z / 8),
            Math.floor(state.health / 2), Math.floor(state.food / 2), items, state.stage, task]);
        if (last?.signature === signature && !state.active) return;
        record({ at: time, signature });
        send(`[ermsies] (${[x,y,z].map(Math.floor).join(', ')}) | health ${Math.ceil(state.health)}/20, food ${state.food}/20 | ${items} | task: stage ${state.stage}, ${task}`);
    };
}

module.exports = { createStatusTicker };
