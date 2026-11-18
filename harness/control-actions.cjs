const { setTimeout: delay } = require('node:timers/promises');
const Vec3 = require('vec3');
const { goals } = require('mineflayer-pathfinder');
const { climbPillar } = require('./pillar.cjs');

const faces = new Map([
    ['up', new Vec3(0, 1, 0)], ['down', new Vec3(0, -1, 0)],
    ['north', new Vec3(0, 0, -1)], ['south', new Vec3(0, 0, 1)],
    ['west', new Vec3(-1, 0, 0)], ['east', new Vec3(1, 0, 0)],
]);

async function runGameplay(command, args, { current, sender, setAction, CommandError, position, integer, describePosition, setWalkingMovements, chatText }) {
    switch (command) {
        case 'say': {
            current.chat(chatText(args[0]));
            return { sent: true };
        }
        case 'whisper':
            if (!/^[a-z0-9_]{1,16}$/i.test(args[0])) throw new CommandError('Enter a valid Minecraft player name.');
            current.whisper(args[0], chatText(args[1]));
            return { sent: true };
        case 'goto': {
            const { x, y, z } = position(args);
            setWalkingMovements(current);
            current.pathfinder.setGoal(new goals.GoalBlock(x, y, z));
            return setAction({ type: 'goto', x, y, z });
        }
        case 'follow': {
            const player = current.players[args[0]];
            if (!player?.entity || player.entity === current.entity) throw new CommandError('Player is not in view.');
            setWalkingMovements(current);
            current.pathfinder.setGoal(new goals.GoalFollow(player.entity, 2), true);
            return setAction({ type: 'follow', player: player.username }, sender);
        }
        case 'look': {
            const [yaw, pitch] = args.map(Number);
            if (args.some(x => !x.trim()) || !Number.isFinite(yaw) || Math.abs(yaw) > 360 || !Number.isFinite(pitch) || Math.abs(pitch) > 90)
                throw new CommandError('Use yaw from -360 to 360 and pitch from -90 to 90 (degrees).');
            await current.look(yaw * Math.PI / 180, pitch * Math.PI / 180, true);
            return { yaw, pitch };
        }
        case 'dig': {
            const block = current.blockAt(position(args));
            if (!block || !current.canDigBlock(block)) throw new CommandError('That block cannot be dug from here.');
            await current.dig(block, true);
            return { dug: block.name };
        }
        case 'step': {
            const bearings = { north: 0, west: Math.PI / 2, south: Math.PI, east: -Math.PI / 2 };
            if (!Object.hasOwn(bearings, args[0]) || !['walk', 'jump'].includes(args[1]))
                throw new CommandError('Use step north|east|south|west walk|jump.');
            current.pathfinder.setGoal(null);
            setAction(null);
            try {
                await current.look(bearings[args[0]], 0, true);
                current.setControlState('forward', true);
                if (args[1] === 'jump') current.setControlState('jump', true);
                await delay(args[1] === 'jump' ? 500 : 300);
            } finally {
                current.clearControlStates();
            }
            return { position: describePosition(current.entity.position) };
        }
        case 'pillar': {
            const height = integer(args[0], 1, 8);
            const base = current.entity.position.floored();
            const counts = new Map();
            for (const item of current.inventory.items()) {
                if (/^(?:dirt|cobblestone|cobbled_deepslate|[a-z_]+_planks)$/.test(item.name))
                    counts.set(item.name, (counts.get(item.name) ?? 0) + item.count);
            }
            const material = current.inventory.items().find(item => counts.get(item.name) >= height);
            if (!material) throw new CommandError('Not enough scaffold blocks of one kind for this climb.');
            for (let offset = 0; offset <= height + 1; offset++) {
                const block = current.blockAt(base.offset(0,offset,0));
                if (!block || !/^(air|cave_air|void_air)$/.test(block.name))
                    throw new CommandError('The pillar column must be clear above your feet.');
            }
            current.pathfinder.setGoal(null);
            setAction(null);
            const result = await climbPillar(current, { base, height, material, active: () => current.health > 0 });
            return { ...result, position: describePosition(current.entity.position) };
        }
        case 'place': {
            const face = faces.get(args[3]);
            if (!face) throw new CommandError('Choose up, down, north, south, west, or east.');
            const block = current.blockAt(position(args));
            if (!block || block.boundingBox === 'empty' || block.position.distanceTo(current.entity.position) > 5)
                throw new CommandError('A solid reference block within reach is required.');
            if (!current.heldItem) throw new CommandError('Equip a block before placing.');
            await current.placeBlock(block, face);
            return { placed: describePosition(block.position.plus(face)) };
        }
        case 'equip': {
            const item = current.inventory.items().find(item => item.name === args[0]);
            if (!item) throw new CommandError('Item not found in inventory.');
            await current.equip(item, 'hand');
            return { equipped: item.name };
        }
        case 'attack': {
            const target = /^\d+$/.test(args[0]) ? current.entities[args[0]] : current.players[args[0]]?.entity;
            if (!target || target === current.entity || !target.position || target.position.distanceTo(current.entity.position) > 3)
                throw new CommandError('Target must be in view and within melee reach.');
            current.attack(target);
            return { attacked: target.id };
        }
    }
}

module.exports = { runGameplay };
