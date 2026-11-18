#!/usr/bin/env bash
set -u
umask 077
cd -- "$(dirname -- "$0")" || exit 1
exec 9>> supervisor.lock
if ! flock -n 9; then
    printf 'An ermsies supervisor already holds the lock.\n' >&2
    exit 78
fi

child=
stop() {
    if [[ -n "$child" ]]; then
        kill -TERM "$child" 2>/dev/null || true
        wait "$child" 2>/dev/null || true
    fi
    exit 0
}
trap stop TERM INT HUP

base=5
while true; do
    rm -f -- supervisor-stable.pid
    node daemon.mjs --auth microsoft &
    child=$!
    wait "$child"
    result=$?
    daemon_pid=$child
    child=
    if (( result == 0 || result == 78 )); then
        exit "$result"
    fi
    if [[ -r supervisor-stable.pid && "$(<supervisor-stable.pid)" == "$daemon_pid" ]]; then
        base=5
    fi
    low=$(( base * 4 / 5 ))
    high=$(( base * 6 / 5 ))
    (( low < 5 )) && low=5
    (( high > 300 )) && high=300
    delay=$(( low + RANDOM % (high - low + 1) ))
    printf '[%s] Daemon exited with status %s; restarting in %ss.\n' "$(date -u +%FT%TZ)" "$result" "$delay" | tee -a daemon.log
    sleep "$delay" &
    child=$!
    wait "$child"
    child=
    base=$(( base < 150 ? base * 2 : 300 ))
done
