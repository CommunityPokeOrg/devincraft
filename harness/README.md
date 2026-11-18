# Devincraft bot controls

On this VM the service starts with idle behavior enabled. Use `devincraft auto off`
to disable it for the current daemon run, or `devincraft auto on` to re-enable it.
`devincraft status` reports autonomous behavior separately from manual actions.
Gameplay commands preempt idle actions; `stop` pauses autonomy briefly, while
`auto off` stops it until explicitly enabled or the daemon restarts.

The idle planner runs in a worker and only emits proposed actions. The daemon
executes those through time-sliced Mineflayer pathfinding and backs off after
event-loop stalls. It uses short walks near its starting position, follows
nearby players briefly, and greets joiners with cooldowns. Gathering is limited
to log drops and natural-looking trunks away from players and visible signs of
construction; Minecraft does not tell clients who placed every block.

## Direct controls

From the installed bot's runtime directory:

```sh
./devincraft status
./devincraft --help
```

The CLI uses a private Unix socket. When the bot is awaiting Microsoft authorization, status and recent chat are available; gameplay commands require a spawn. Manual `goto` does not mine or place blocks. The driver has no host-shell or arbitrary eval command.

Use `devincraft goal` (also the MCP `goal` tool) to see the current diamond stage,
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
three minutes apart. It skips unchanged idle updates. Use `devincraft statusloop
on|off` or the MCP `statusloop` tool to toggle it. The last post and toggle
are saved across behavior reloads.

Use `devincraft reload` after changing the idle planner, foraging, scene, player-chat, or gameplay handlers. It replaces those handlers in the running process without reconnecting, and preserves the autonomy toggle and current manual movement. Changes to the socket transport or daemon itself are not hot-reloaded.

The bot recognizes a mention of its current in-game account and answers whispers privately. It recognizes greetings, help, status, where-are-you, follow-me, and stop; chat cannot take over a movement task started through the CLI. Unhandled messages are kept in a private rolling inbox on disk. Read them with `devincraft inbox`, and use `devincraft say` or `devincraft whisper` to answer manually.

For an MCP client, use `node` with the absolute path to `mcp.cjs` as its only argument. The wrapper uses stdio and forwards the same tools to the socket.

The VM runs the bot as a systemd service, independent of tmux and the CLI. Inspect it with `systemctl status <bot-unit>`; lifecycle events and per-minute protocol and event-loop measurements are in `daemon.log`. Set `BOT_USERNAME` privately in `/etc/devincraft-bot.env` for a new installation. The protected `profiles/` folder caches Microsoft credentials; do not share or commit it.

The supervisor holds the single-instance lock and restarts crashes; the daemon matches the harness's 60-second Minecraft keepalive deadline. Both retry with exponential backoff and jitter (5 seconds to 5 minutes), resetting the backoff only after 2 minutes of continuous play. The daemon does not retry permanent kicks. Pathfinding yields between 15ms slices; CLI/MCP clients are separate processes, and inbox writes are asynchronous.

If Microsoft approval is needed again, stop the service and run `bash supervise.sh` from the runtime directory in a private foreground terminal with `BOT_USERNAME` set. Device codes are printed only to the foreground console, not written to the daemon log. Stop it before starting the service again.

## Screenshots

`bash harness/screenshot-latest.sh` reads a snapshot from the existing private
control socket. A separate Prismarine Viewer listens on loopback port 38719,
and headless Chrome uses software WebGL (SwiftShader) and CDP on loopback port
38720 to capture the view. No display server or hardware GPU is required.
Install Node.js 22 or later, Google Chrome, and the viewer dependencies with
`npm install --prefix harness/viewer`. Set `BOT_VIEWER_DIR` to reuse another
directory of installed viewer dependencies; set `BOT_CONTROL_SOCKET` if your
daemon uses a different socket path.

The capture timer runs every ten minutes. Successful renders replace
`screenshots/latest.png` and keep the latest five images locally in
`$HOME/devincraft-shots` (overridable with `BOT_SHOTS_DIR`). The separate
publication timer commits only that file, only when it changed, and at most
every 30 minutes. It requires an authenticated, up-to-date checkout of `main`
with a Git author configured. Both timers use `/etc/devincraft-screenshot.env`
if it exists. Neither timer starts or restarts the bot.
