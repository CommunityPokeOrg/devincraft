# Autonomous idle behavior

On this VM the service starts with idle behavior enabled. Use `ermsies auto off`
to disable it for the current daemon run, or `ermsies auto on` to re-enable it.
`ermsies status` reports autonomous behavior separately from manual actions.
Gameplay commands preempt idle actions; `stop` pauses autonomy briefly, while
`auto off` stops it until explicitly enabled or the daemon restarts.

The idle planner runs in a worker and only emits proposed actions. The daemon
executes those through time-sliced Mineflayer pathfinding and backs off after
event-loop stalls. It uses short walks near its starting position, follows
nearby players briefly, and greets joiners with cooldowns. Gathering is limited
to log drops and natural-looking trunks away from players and visible signs of
construction; Minecraft does not tell clients who placed every block.

# Direct ermsies controls

In the harness clone:

```sh
.agent-state/ermsies-direct/ermsies status
.agent-state/ermsies-direct/ermsies --help
```

The CLI uses a private Unix socket. When the bot is awaiting Microsoft authorization, status and recent chat are available; gameplay commands require a spawn. Manual `goto` does not mine or place blocks. The driver has no host-shell or arbitrary eval command.

Use `ermsies goal` (also the MCP `goal` tool) to see the current diamond stage,
needs, blockers, death count and diamond budget. The target is 29 diamonds:
24 for armor, 2 for a sword, and 3 for a pickaxe. Live readiness can regress
when supplies are lost; `diamond-progress.json` saves the highest stage and
diamond count, deaths since tracking began, and the mining route. The pipeline
survives and stocks up before upgrading tools; it then smelts supplies,
staircases to diamond level and crafts missing diamond equipment. Autonomous
workstation recovery can dig through dry natural terrain and scaffold an ascent.
The bot crafts a replacement workbench when it has the wood to spare. If an
attempt to recover an old table takes two minutes, it abandons that route and
heads to the surface for eight logs. Before descending, it packs both
workstations and keeps eight plank-equivalents (two logs) and two sticks spare.

While spawned, the bot checks whether to post an in-game progress line at
random intervals between three and five minutes, never posting less than
three minutes apart. It skips unchanged idle updates. Use `ermsies statusloop
on|off` or the MCP `statusloop` tool to toggle it. The last post and toggle
are saved across behavior reloads.

Use `ermsies reload` after changing the idle planner, foraging, scene, player-chat, or gameplay handlers. It replaces those handlers in the running process without reconnecting, and preserves the autonomy toggle and current manual movement. Changes to the socket transport or daemon itself are not hot-reloaded.

The bot replies to player messages addressed to `ermsies` and answers whispers privately. It recognizes greetings, help, status, where-are-you, follow-me, and stop; chat cannot take over a movement task started through the CLI. Unhandled messages are kept in a private rolling inbox on disk. Read them with `ermsies inbox`, and use `ermsies say` or `ermsies whisper` to answer manually.

For an MCP client, use `node` with the absolute path to `mcp.cjs` as its only argument. The wrapper uses stdio and forwards the same tools to the socket.

The VM runs `ermsies-direct.service`, independent of tmux and the CLI. Inspect it with `systemctl status ermsies-direct.service`; lifecycle events and per-minute protocol and event-loop measurements are in `daemon.log`. The protected `profiles/` folder caches Microsoft credentials; do not share or commit it.

The supervisor holds the single-instance lock and restarts crashes; the daemon matches the harness's 60-second Minecraft keepalive deadline. Both retry with exponential backoff and jitter (5 seconds to 5 minutes), resetting the backoff only after 2 minutes of continuous play. The daemon does not retry permanent kicks. Pathfinding yields between 15ms slices; CLI/MCP clients are separate processes, and inbox writes are asynchronous.

If Microsoft approval is needed again, stop the service and run `bash .agent-state/ermsies-direct/supervise.sh` in a private foreground terminal. Device codes are printed only to the foreground console, not written to the daemon log. Stop it before starting the service again.
