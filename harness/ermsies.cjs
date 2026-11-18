#!/usr/bin/env node
const { call } = require('./client.cjs');

const [command = 'status', ...args] = process.argv.slice(2);
if (command === '--help' || command === 'help') {
    console.log(`Usage: ermsies <command>
  status                       Player, inventory, and nearby entities
  goal                         Diamond progression, needs, counts, and deaths
  say "message"                Send one line of normal chat
  whisper <player> "message"   Send a private in-game message
  chat [limit]                 Read recent chat (default 20)
  inbox [limit]                Read unhandled addressed messages
  auto <on|off>                Enable or disable idle behavior
  statusloop <on|off>          Enable or disable periodic progress chat
  reload                       Reload behavior and handlers without reconnecting
  goto <x> <y> <z>              Start pathfinding to block coordinates
  follow <player>              Follow a visible player
  look <yaw> <pitch>           Look in the given direction (degrees)
  dig <x> <y> <z>               Dig an in-reach block
  step <direction> <walk|jump>  Take one short cardinal move
  pillar <height>              Jump-place up through a clear column
  place <x> <y> <z> <face>      Place the held block against a reference block
  equip <item>                 Equip an inventory item to the main hand
  attack <entity-id|player>     Make one melee attack
  stop                         Stop movement and digging`);
} else {
    call(command, args).then(result => console.log(JSON.stringify(result, null, 2)), error => {
        console.error(`ermsies: ${error.message}`);
        process.exitCode = 1;
    });
}
