#!/usr/bin/env bash
set -euo pipefail
umask 077

repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
shots=${BOT_SHOTS_DIR:-"$HOME/devincraft-shots"}
viewer=${BOT_VIEWER_DIR:-"$repo/harness/viewer"}
socket=${BOT_CONTROL_SOCKET:-"$HOME/repos/minecraft-agent-harness/.agent-state/devincraft-bot/control.sock"}

mkdir -p -- "$shots" "$repo/screenshots"
exec 9>"$shots/.screenshot.lock"
flock -n 9 || exit 0
work=$(mktemp -d "$shots/.capture.XXXXXXXX")
cleanup() {
    for pid in "${capture_pid:-}" "${viewer_pid:-}"; do
        if [[ -n "$pid" ]]; then
            kill -TERM -- "-$pid" 2>/dev/null || true
            wait "$pid" 2>/dev/null || true
        fi
    done
    rm -rf -- "$work"
    if [[ -n "${dest:-}" ]]; then rm -f -- "$dest"; fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM
dest=$(mktemp "$repo/screenshots/.latest.XXXXXXXX")

curl --fail --silent --show-error --max-time 8 --unix-socket "$socket" http://localhost/scene >"$work/scene.ndjson"
if [[ -n "$(ss -Hltn '( sport = :38719 or sport = :38720 )')" ]]; then
    echo "Screenshot ports 38719 and 38720 must be free." >&2
    exit 1
fi

export NODE_PATH="${NODE_PATH:+$NODE_PATH:}$viewer/node_modules"
setsid nice -n 10 node "$repo/harness/viewer/show.cjs" "$work/scene.ndjson" 9>&- &
viewer_pid=$!
ready=false
for ((i=0; i<30; i++)); do
    if curl --fail --silent --max-time 1 http://127.0.0.1:38719/ >/dev/null; then
        ready=true
        break
    fi
    kill -0 "$viewer_pid" 2>/dev/null || break
    sleep 0.2
done
if ! "$ready"; then
    echo "Screenshot viewer did not start." >&2
    exit 1
fi

setsid nice -n 10 timeout --foreground 35s node "$repo/harness/viewer/capture.mjs" "$work/latest.png" "$work/chrome" 9>&- &
capture_pid=$!
wait "$capture_pid"
test -s "$work/latest.png"

for i in 4 3 2; do
    older="$shots/previous-$((i - 1)).png"
    if [[ -f "$older" ]]; then mv -- "$older" "$shots/previous-$i.png"; fi
done
if [[ -f "$shots/latest.png" ]]; then cp -- "$shots/latest.png" "$shots/previous-1.png"; fi
cp -- "$work/latest.png" "$dest"
mv -f -- "$work/latest.png" "$shots/latest.png"
mv -f -- "$dest" "$repo/screenshots/latest.png"
printf 'Updated %s and %s\n' "$shots/latest.png" "$repo/screenshots/latest.png"
