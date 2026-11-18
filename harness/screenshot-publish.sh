#!/usr/bin/env bash
set -euo pipefail
umask 077
export GIT_TERMINAL_PROMPT=0

cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
shots=${BOT_SHOTS_DIR:-"$HOME/devincraft-shots"}
latest=screenshots/latest.png
message='Update latest bot screenshot'
mkdir -p -- "$shots"
exec 9>"$shots/.screenshot.lock"
flock -w 50 9
[[ "$(git branch --show-current)" == main && -s "$latest" ]] || exit 0

git fetch --quiet origin main
if [[ "$(git rev-parse HEAD)" != "$(git rev-parse FETCH_HEAD)" ]]; then
    if [[ "$(git rev-parse HEAD^)" == "$(git rev-parse FETCH_HEAD)" &&
          "$(git show -s --format=%s HEAD)" == "$message" &&
          "$(git diff-tree --no-commit-id --name-only -r HEAD)" == "$latest" ]]; then
        git push --quiet origin HEAD:main
        exit 0
    fi
    echo "Skipping screenshot publication: main has unpublished or divergent changes." >&2
    exit 1
fi
git diff --quiet HEAD -- "$latest" && exit 0
git commit --quiet --only -m "$message" -- "$latest"
git push --quiet origin HEAD:main
