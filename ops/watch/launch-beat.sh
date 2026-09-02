#!/usr/bin/env bash
# Resilience wrapper for the heartbeat: keep it running, relaunch if it ever exits.
# The heartbeat is already a while-loop that tolerates a missing network (it holds
# quietly and recovers), so this only matters if the script itself dies (killed,
# node missing, etc.).
cd "$(dirname "$0")"
while true; do
  ./heartbeat.sh
  echo "[relay-watch] heartbeat exited (status $?); relaunching in 5s."
  sleep 5
done
