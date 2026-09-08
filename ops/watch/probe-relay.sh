#!/usr/bin/env bash
#
# probe-relay.sh - read-only remote diagnostics tap for the relay fleet.
#
# WHY THIS EXISTS
#   The Mac watcher runs headless in --permission-mode auto (the heartbeat pokes
#   it with no human present), so .claude/settings.json hard-denies ssh/sudo/rm
#   as the ONLY guardrail against an unattended, confused agent doing damage.
#   That blunt deny also blocked legitimate read-only investigation you had
#   explicitly authorized (pulling relay1's journal to time a shard-map blip).
#
#   This wrapper threads the needle. It runs a FIXED set of read-only remote
#   commands whose remote command string the LLM never composes. The agent gets
#   the RAW output back and does all the slicing/dicing (grep/head/tail/regex)
#   LOCALLY on the Mac, where it is harmless. So: keep `Bash(ssh *)` denied,
#   allow ONLY `Bash(./probe-relay.sh *)`. The remote side stays a dumb data
#   tap; the unforeseeable investigative creativity lives locally.
#
# WHAT IT WILL NOT DO
#   The only LLM-supplied inputs that reach the box are: a host and a unit (both
#   chosen from allowlists below - an off-list value is rejected, never passed
#   through), a --since/--until timestamp and an -n count (both strictly
#   validated), and a metrics port (integer). Every remote command is a fixed
#   template with those values single-quoted as data arguments, so they can only
#   ever be arguments to journalctl/curl/systemctl - never a command of their
#   own. There is no subcommand that mutates anything.
#
# USAGE
#   ./probe-relay.sh journal [--host H] [--unit U] [--since T] [--until T] [-n N]
#   ./probe-relay.sh metrics [--host H] [--port P]
#   ./probe-relay.sh status  [--host H] [--unit U]
#
#   Then slice locally, e.g. the investigation that motivated this:
#     ./probe-relay.sh journal --since '2026-09-07 03:00' --until '2026-09-07 07:00' \
#       | grep -iaE 'shard|resolver|map|fetch|econn|timeout|getaddr' | head -40
#     ./probe-relay.sh metrics | grep -iE 'map|shard|fetch|resolver'
#     ./probe-relay.sh status | grep -iE 'ActiveEnter|NRestarts|ActiveState'
#
# HOSTS  interserver1 = relay1.iterm2.com,  interserver2 = relay2.iterm2.com
# UNITS  relay = iterm2-companion-relay.service (verified 2026-09-07 as the live
#        unit on both interserver1/2; the RUNBOOK's -cf suffix is stale),
#        dashboard = iterm2-relay-dashboard.service
#
set -euo pipefail

# --- allowlists: the LLM may pick a key from these; anything else is rejected ---
declare -A HOST_OK=( [interserver1]=1 [interserver2]=1 )
declare -A UNIT_MAP=(
  [relay]=iterm2-companion-relay.service
  [dashboard]=iterm2-relay-dashboard.service
)
DEFAULT_HOST=interserver1
DEFAULT_UNIT=relay
DEFAULT_PORT=8787          # relay /metrics on the box (loopback-only)
JOURNAL_CAP=2000           # -n cap applied when no --since and no -n given

die() { printf 'probe-relay: %s\n' "$*" >&2; exit 2; }

# Strict validators. The one character that could break out of a single-quoted
# remote argument is a single quote; the charset below excludes it (and ; | & $
# ` / \ and quotes), so a validated value can only ever be data to journalctl.
valid_ts()   { [[ "$1" =~ ^[A-Za-z0-9:._+\ -]+$ ]]; }   # "2026-09-07 03:00", "2 hours ago", "-1h"
valid_int()  { [[ "$1" =~ ^[0-9]+$ ]]; }

[[ $# -ge 1 ]] || die "usage: probe-relay.sh {journal|metrics|status} [opts] (see header)"
sub="$1"; shift

host="$DEFAULT_HOST" unit_key="$DEFAULT_UNIT" since="" until="" nlines="" port="$DEFAULT_PORT"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --host)  host="${2:-}";      shift 2 ;;
    --unit)  unit_key="${2:-}";  shift 2 ;;
    --since) since="${2:-}";     shift 2 ;;
    --until) until="${2:-}";     shift 2 ;;
    -n)      nlines="${2:-}";    shift 2 ;;
    --port)  port="${2:-}";      shift 2 ;;
    *) die "unknown option: $1" ;;
  esac
done

[[ -n "${HOST_OK[$host]:-}" ]] || die "host not allowed: '$host' (allowed: ${!HOST_OK[*]})"
unit="${UNIT_MAP[$unit_key]:-}"
[[ -n "$unit" ]] || die "unit not allowed: '$unit_key' (allowed: ${!UNIT_MAP[*]})"
[[ -z "$since"   ]] || valid_ts  "$since"   || die "bad --since: '$since'"
[[ -z "$until"   ]] || valid_ts  "$until"   || die "bad --until: '$until'"
[[ -z "$nlines"  ]] || valid_int "$nlines"  || die "bad -n: '$nlines'"
valid_int "$port" || die "bad --port: '$port'"

# Build the fixed remote command. Values are single-quoted -> data only.
case "$sub" in
  journal)
    remote="sudo journalctl -u '$unit' --utc --no-pager"
    [[ -n "$since"  ]] && remote+=" --since '$since'"
    [[ -n "$until"  ]] && remote+=" --until '$until'"
    if [[ -n "$nlines" ]]; then
      remote+=" -n '$nlines'"
    elif [[ -z "$since" ]]; then
      remote+=" -n '$JOURNAL_CAP'"   # avoid dumping the entire journal by default
    fi
    ;;
  metrics)
    remote="curl -sS --max-time 10 'http://localhost:$port/metrics'"
    ;;
  status)
    remote="systemctl show '$unit' -p ActiveState -p SubState -p ActiveEnterTimestamp"
    remote+=" -p NRestarts -p MainPID -p ExecMainStartTimestamp -p NRestarts; echo '---'; "
    remote+="systemctl status '$unit' --no-pager -n 0 || true"
    ;;
  *) die "unknown subcommand: '$sub' (journal|metrics|status)" ;;
esac

# Show the operator exactly what ran (stderr, so it never pollutes the piped output).
printf '# %s  $ %s\n' "$host" "$remote" >&2

exec ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new \
  "$host" "$remote"
