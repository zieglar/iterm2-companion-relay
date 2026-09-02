#!/usr/bin/env bash
# Bootstrap the watcher in a detached tmux session on a PRIVATE socket, with two
# windows:
#   window "claude" - an always-live, idle, interactive Claude you attach to and
#                     control (from the Mac or the iTerm2 companion app on your
#                     phone). It runs the triage and posts the notification.
#   window "beat"   - heartbeat.sh, the cheap probe loop that pokes the claude
#                     window (tmux send-keys) when there is sustained trouble.
#
# Why a private socket (-L relaywatch): it is a SEPARATE tmux server from your
# everyday tmux. Your `tmux kill-server` / restarts hit the default socket and
# never touch this one, so the watcher keeps running. (A `pkill tmux` would still
# take it down; use `tmux -L relaywatch kill-session` to stop just the watcher.)
# tmux 3.x also renders Claude's TUI properly, unlike the ancient system screen.
set -euo pipefail
cd "$(dirname "$0")"
DIR="$(pwd)"

[ -f watch.env ] && { set -a; . ./watch.env; set +a; }
SOCKET="${WATCH_TMUX_SOCKET:-relaywatch}"
SESSION="${WATCH_SESSION:-relay-watch}"
CLAUDE_WIN="${WATCH_CLAUDE_WINDOW:-claude}"
TM=(tmux -L "$SOCKET")

if "${TM[@]}" has-session -t "$SESSION" 2>/dev/null; then
  echo "watcher '${SESSION}' already running (tmux socket '${SOCKET}')."
  echo "  attach: tmux -L ${SOCKET} attach -t ${SESSION}"
  exit 0
fi

if [ ! -d node_modules/ws ]; then
  echo "installing deps (ws)..."
  npm install --silent
fi
chmod +x heartbeat.sh notify.sh launch-claude.sh launch-beat.sh 2>/dev/null || true

"${TM[@]}" new-session -d -s "$SESSION" -n "$CLAUDE_WIN" "$DIR/launch-claude.sh"
"${TM[@]}" new-window -t "$SESSION" -n beat "$DIR/launch-beat.sh"
"${TM[@]}" select-window -t "${SESSION}:${CLAUDE_WIN}"

echo "started watcher '${SESSION}' on tmux socket '${SOCKET}' (windows: ${CLAUDE_WIN}, beat)."
echo "  attach:  tmux -L ${SOCKET} attach -t ${SESSION}   (windows: Ctrl-b n/p ; detach: Ctrl-b d)"
echo "  logs:    tail -f state/heartbeat.log"
echo "  stop:    tmux -L ${SOCKET} kill-session -t ${SESSION}"
