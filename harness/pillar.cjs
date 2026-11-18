const { setTimeout: wait } = require('node:timers/promises');
const Vec3 = require('vec3');

const air = block => /^(?:air|cave_air|void_air)$/.test(block?.name ?? '');
const full = block => block?.boundingBox === 'block' && !block.getProperties?.().waterlogged
    && (!block.shapes || block.shapes.some(shape => shape.every((value, i) => value === (i < 3 ? 0 : 1))));
const up = new Vec3(0, 1, 0);

async function climbPillar(bot, { base, height, material, active = () => true, safe = () => true }) {
    const center = base.offset(0.5, 0, 0.5);
    const pos = () => bot.entity.position;
    const centered = () => Math.hypot(pos().x - center.x, pos().z - center.z) <= 0.14;
    const clear = point => [0,1,2].every(y => {
        const cell = point.offset(0,y,0);
        return air(bot.blockAt(cell)) && safe(cell);
    });
    const attempt = async (condition, ticks) => {
        for (let i = 0; i < ticks && active() && !condition(); i++) await wait(20);
        return active() && condition();
    };
    let placed = 0;
    bot.clearControlStates();
    try {
        if (!bot.entity.onGround || !pos().floored().equals(base) || !full(bot.blockAt(base.minus(up))) || !clear(base))
            return { placed, reason: 'No clear, solid starting cell.' };
        if (!centered()) {
            await bot.lookAt(center.offset(0,(bot.entity.eyeHeight ?? 1.62) + pos().y - base.y,0), true);
            if (!active()) return { placed, reason: 'Interrupted.' };
            bot.setControlState('sneak', true);
            bot.setControlState('forward', true);
            const aligned = await attempt(() => centered() || !bot.entity.onGround || !pos().floored().equals(base), 85);
            if (active()) bot.clearControlStates();
            if (!aligned || !centered() || !bot.entity.onGround || !pos().floored().equals(base))
                return { placed, reason: 'Could not center on the starting block.' };
        }
        await bot.equip(material, 'hand');
        for (let y = 0; y < height; y++) {
            const feet = base.offset(0,y,0);
            const anchor = bot.blockAt(feet.minus(up));
            if (!active() || !centered() || !bot.entity.onGround || !pos().floored().equals(feet) || !full(anchor) || !clear(feet))
                return { placed, reason: 'Pillar footing or clearance changed.' };
            await bot.look(bot.entity.yaw ?? 0, -Math.PI / 2, true);
            if (!active()) return { placed, reason: 'Interrupted.' };
            const startY = pos().y;
            bot.setControlState('jump', true);
            const above = await attempt(() => pos().y > startY + 1, 24);
            if (active()) bot.setControlState('jump', false);
            if (!above || !centered() || !air(bot.blockAt(feet)) || !safe(feet))
                return { placed, reason: 'Jump did not clear the placement cell.' };
            try {
                if (typeof bot._placeBlockWithOptions === 'function')
                    await bot._placeBlockWithOptions(anchor, up, { forceLook: 'ignore', swingArm: 'right' });
                else await bot.placeBlock(anchor, up);
            } catch {
                // The server update can arrive after the placement promise times out.
            }
            if (!await attempt(() => bot.blockAt(feet)?.name === material.name, 14))
                return { placed, reason: 'Server did not confirm the block placement.' };
            placed++;
            if (!await attempt(() => bot.entity.onGround && pos().floored().equals(feet.plus(up)), 45))
                return { placed, reason: 'Did not land on the placed block.' };
        }
        return { placed };
    } finally {
        if (active()) bot.clearControlStates();
    }
}

module.exports = { climbPillar };
