#!/usr/bin/env bash
# The always-on heartbeat. No LLM. It samples tick.mjs on a timer and, only on
# SUSTAINED relay-shaped trouble (with this Mac's own internet healthy), POKES the
# live `claude` window in this same tmux session via `tmux send-keys`, so the
# interactive, phone-controllable Claude runs the triage and owns all user-facing
# output (the OSC 9 page, the incident report). The heartbeat only decides WHEN to
# wake Claude, and dedupes so you are poked once per incident (with an occasional
# nudge if it drags on). It never pages by itself, because an OSC 9 from this
# background window would not reach iTerm2 until you switched to it; Claude, in the
# window you actually attach to, is the right emitter.
set -uo pipefail
cd "$(dirname "$0")"
[ -f watch.env ] && { set -a; . ./watch.env; set +a; }

SOCKET="${WATCH_TMUX_SOCKET:-relaywatch}"
SESSION="${WATCH_SESSION:-relay-watch}"
CLAUDE_WIN="${WATCH_CLAUDE_WINDOW:-claude}"
QUIET_INTERVAL="${WATCH_QUIET_INTERVAL:-120}" # seconds between checks while healthy
RETRY_INTERVAL="${WATCH_RETRY_INTERVAL:-20}"  # seconds between confirm re-checks
CONFIRM_FAILS="${WATCH_CONFIRM_FAILS:-2}"     # consecutive relay fails before waking Claude
REPOKE_SECONDS="${WATCH_REPOKE_SECONDS:-900}" # re-nudge an unresolved incident at most this often
mkdir -p state incidents

log()        { printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*" | tee -a state/heartbeat.log; }
verdict_of() { grep -o '"verdict"[^,]*' "$1" 2>/dev/null | head -1 | sed 's/.*"\([a-z-]*\)"$/\1/'; }
# Claude's input box treats an inline newline as "insert a line", not "send", so
# deliver the message (as literal text, -l) and the submitting Enter as two
# discrete send-keys with a beat in between; the lone Enter then registers as a
# real Enter keypress and submits. Retries a few times because send-keys can fail
# transiently (e.g. a resize race while the session is being attached), and
# returns non-zero if it never lands so the caller can keep the incident live and
# retry next cycle rather than silently believing Claude was woken.
poke() {
  # Prefix every poke with the wall-clock time it was SENT. If Claude was busy,
  # pokes queue in its input; the timestamps let it see a batch arrived (and how
  # old each is) and collapse them into one triage against current state instead
  # of re-triaging per queued poke. See PLAYBOOK.md "Batched / queued pokes".
  local msg="[poke @ $(date '+%Y-%m-%dT%H:%M:%S%z')] $1"
  local n
  for n in 1 2 3; do
    if tmux -L "$SOCKET" send-keys -t "${SESSION}:${CLAUDE_WIN}" -l "$msg" 2>>state/heartbeat.log; then
      sleep 0.4
      tmux -L "$SOCKET" send-keys -t "${SESSION}:${CLAUDE_WIN}" Enter 2>>state/heartbeat.log
      return 0
    fi
    log "poke attempt ${n}/3 failed (send-keys); retrying"
    sleep 1
  done
  log "WARN: could not poke '${CLAUDE_WIN}' after 3 attempts"
  return 1
}

cat <<'BANNER'
================================================================================
 relay-watch heartbeat  -  the deterministic probe loop (no LLM).
 Quiet when healthy; a "tick ok" pulse prints each cycle, and real events
 (failures, poking Claude, recovery) print here and to state/heartbeat.log.
 The interactive watcher is the "claude" window: Ctrl-b p.
================================================================================
BANNER
log "heartbeat up (quiet=${QUIET_INTERVAL}s retry=${RETRY_INTERVAL}s confirm=${CONFIRM_FAILS})"
fails=0
incident=0        # 1 while we believe an incident is active
last_poke=0
offline=0         # 1 while this Mac itself has no working internet
last_offline_log=0
while true; do
  if node tick.mjs > state/tick.out 2> state/tick.err; then
    if [ "$offline" = 1 ]; then log "network restored - this Mac is back online; resuming normal watch"; offline=0; fi
    if [ "$incident" = 1 ]; then
      log "recovered; poking RESOLVED"
      poke "RESOLVED: relays reachable again from this Mac. Confirm, post recovery per PLAYBOOK.md, then stand down."
      incident=0
    fi
    fails=0
    printf '%s  tick ok - all relays reachable from this Mac\n' "$(date '+%H:%M:%S')"
    sleep "$QUIET_INTERVAL"; continue
  fi

  verdict="$(verdict_of state/tick.out)"

  # This Mac's own internet is down (or the tick errored): a blind vantage, almost
  # always local. Do NOT wake Claude or page; just wait it out and recover when the
  # network returns. Throttle the logging so a long outage does not flood the log or
  # the beat window: announce once on going offline, then at most every 5 minutes.
  if [ "$verdict" = "mac-offline" ] || [ "$verdict" = "tick-error" ]; then
    now="$(date +%s)"
    if [ "$offline" = 0 ]; then
      log "this Mac has no working internet (verdict=${verdict}); holding quietly, not waking Claude. Will resume automatically when the network returns."
      offline=1; last_offline_log="$now"
    elif [ $((now - last_offline_log)) -ge 300 ]; then
      log "still offline (verdict=${verdict}); holding"
      last_offline_log="$now"
    fi
    fails=0
    sleep "$RETRY_INTERVAL"; continue
  fi

  fails=$((fails + 1))
  log "relay check failed ${fails}/${CONFIRM_FAILS} (verdict=${verdict})"
  if [ "$fails" -lt "$CONFIRM_FAILS" ]; then
    sleep "$RETRY_INTERVAL"; continue
  fi

  now="$(date +%s)"
  if [ "$incident" = 0 ] || [ $((now - last_poke)) -ge "$REPOKE_SECONDS" ]; then
    {
      echo "# Relay watch incident $(date '+%Y-%m-%dT%H:%M:%S%z')"
      echo
      echo "Verdict: ${verdict}. ${fails} consecutive relay-reachability failures from"
      echo "this Mac while this Mac's internet is healthy."
      echo
      echo '```json'
      cat state/tick.out
      echo '```'
    } > state/incident-brief.md
    log "waking Claude (verdict=${verdict})"
    if poke "TRIAGE: sustained relay failure (verdict=${verdict}). Read state/incident-brief.md and PLAYBOOK.md, then triage now."; then
      incident=1
      last_poke="$now"
    else
      log "poke did not land; leaving incident unmarked to retry next cycle"
    fi
  fi
  sleep "$RETRY_INTERVAL"
done
