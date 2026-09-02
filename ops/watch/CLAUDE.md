# Relay watcher - operator notes (read me first)

This directory is a **self-hosted monitor for the iTerm2 companion relay fleet** that
runs on George's Mac. It exists because the off-box monitor (mcnachman.cloud) pages
from a single network vantage and false-alarms when *its* path to a relay blips while
the relays are actually serving users fine. This watcher is an **independent second
vantage**: it probes the relays from this Mac and only escalates when it *itself*
cannot reach them.

George's main way of interacting with this is to run `claude` in this directory and
ask. So: the operational knowledge lives here. Don't make him remember tmux flags.

## Where it runs (the part nobody remembers)

A detached **tmux session on a PRIVATE socket**: `tmux -L relaywatch`, session
`relay-watch`. The private socket keeps it separate from George's everyday tmux, so
his `tmux kill-server`/restarts never touch it.

| Do this | Command |
|---|---|
| Attach (see/drive it) | `tmux -L relaywatch attach -t relay-watch` |
| Detach | `Ctrl-b d` |
| Switch windows | `Ctrl-b n` / `Ctrl-b p` (windows: `claude`, `beat`) |
| Peek without attaching | `tmux -L relaywatch capture-pane -p -t relay-watch:claude` |
| Peek at the heartbeat | `tmux -L relaywatch capture-pane -p -t relay-watch:beat` |
| Is it running? | `tmux -L relaywatch has-session -t relay-watch && echo up` |
| Start it (idempotent) | `./run.sh` |
| Stop it | `tmux -L relaywatch kill-session -t relay-watch` |
| Live heartbeat log | `tail -f state/heartbeat.log` |

`capture-pane` works while detached, so prefer it over attaching when you just want
to look (attaching can cause a resize that briefly disrupts things).

## The two windows

- **`claude`** - an always-live, idle Claude Code session (this is the agent that
  triages). It runs in `--permission-mode auto` (no permission prompts) with a hard
  `deny` list in `.claude/settings.json` (ssh/sudo/systemctl/kill/rm/... blocked even
  under auto). It boots from `ROLE.txt`, reads `PLAYBOOK.md`, then idles until poked.
- **`beat`** - `heartbeat.sh`, a cheap deterministic probe loop (no LLM). Every ~2 min
  it runs `tick.mjs`; prints a `tick ok` pulse when healthy; on sustained trouble it
  pokes the `claude` window via `tmux send-keys`.

## How it decides (and why it rarely pages)

1. `tick.mjs` does a real owned-room mac-park handshake to every relay in the live
   shard map, PLUS control fetches (resolver/Cloudflare/Google) proving this Mac has
   internet. Verdict: `ok`, `some-relays-unreachable`, `all-relays-unreachable`,
   `mac-offline`, `map-unreachable`.
2. `mac-offline` (this Mac's own internet is down) -> heartbeat holds quietly, never
   wakes Claude, recovers automatically when the network returns. This is the biggest
   false-alarm source and it is handled deterministically.
3. Two consecutive relay-shaped failures (Mac online) -> heartbeat pokes Claude with
   `TRIAGE:`. Claude re-probes independently, cross-checks the monitor, and pages
   ONLY if the relay is genuinely unreachable from here. A blip that clears -> logged
   to `state/transients.log`, no page. See `PLAYBOOK.md` for the exact decision tree.

## Auto-start at login

launchd agent `~/Library/LaunchAgents/com.iterm2.relay-watch.plist` runs `./run.sh`
at login and every 5 min (self-heal: `run.sh` is idempotent, so a dead session comes
back). Manage it:
- Load/enable: `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.iterm2.relay-watch.plist`
- Unload/disable: `launchctl bootout gui/$(id -u)/com.iterm2.relay-watch`
- Status: `launchctl print gui/$(id -u)/com.iterm2.relay-watch | head`
- Its own log: `state/launchd.log`

## Resilience (network + crashes)

- **No network**: `tick.mjs` fails fast (10s timeouts), heartbeat detects `mac-offline`,
  holds quietly (throttled logging), and resumes on its own when the network is back.
  It does NOT flail or page. Claude sits idle (no API calls while idle).
- **Crashes**: both windows run under restart wrappers (`launch-claude.sh`,
  `launch-beat.sh`) that relaunch on exit. If the whole session dies, the launchd
  self-heal re-creates it within 5 min.

## Running a drill (test end to end without touching a real relay)

`tick.mjs` honors `WATCH_FORCE_FAIL_HOSTS=<host,...>` to report a host as unreachable.
To make the heartbeat autonomously detect it and poke Claude, respawn the beat window
with the flag, then watch:
```
tmux -L relaywatch respawn-window -k -t relay-watch:beat \
  "bash -lc 'WATCH_FORCE_FAIL_HOSTS=relay1.iterm2.com exec $(pwd)/launch-beat.sh'"
# watch: tmux -L relaywatch capture-pane -p -t relay-watch:claude
# disarm: tmux -L relaywatch respawn-window -k -t relay-watch:beat "$(pwd)/launch-beat.sh"
```
Expect Claude to re-probe, find the relay actually healthy (the fault is Mac-side
only), log a transient, and NOT page. To exercise the real page path you must make the
relay genuinely unreachable from this Mac (e.g. /etc/hosts blackhole), which needs
sudo and risks this Mac's own relay connection.

## KNOWN GAP / TODO

**`notify.sh` does not work yet.** It writes OSC 9 to `/dev/tty`, but Claude's Bash
tool runs subprocesses with no controlling terminal, so the page never reaches the
phone. A real drill confirmed this. George is providing a proper push mechanism (a
CLI command or a URL+token to curl); rewrite `notify.sh` around it so it works from a
headless subprocess (no tty). Until then, the "REAL outage -> page your phone" path is
unproven end to end; triage/logging/incident-reports all work.

## Files

- `tick.mjs` - the independent probe (JSON verdict; run by hand any time: `node tick.mjs`)
- `heartbeat.sh` - the probe loop + poke logic
- `launch-claude.sh` / `launch-beat.sh` - restart wrappers for the two windows
- `run.sh` - idempotent bootstrap of the tmux session
- `ROLE.txt` - Claude's standing role prompt
- `PLAYBOOK.md` - the triage procedure Claude follows on a `TRIAGE:` poke
- `notify.sh` - phone page (BROKEN, see TODO)
- `.claude/settings.json` - auto mode + hard deny list
- `watch.env` - local config incl. `MONITOR_PASSWORD` (gitignored)
- `state/` - runtime: `heartbeat.log`, `tick.out`, `last.json`, `transients.log` (gitignored)
- `incidents/` - incident reports Claude writes (gitignored)

## Applying code changes

Editing `heartbeat.sh`/`tick.mjs`/`launch-*.sh` does NOT affect the running process.
Reload the affected window without disturbing the other:
`tmux -L relaywatch respawn-window -k -t relay-watch:beat "$(pwd)/launch-beat.sh"`
(respawning the `claude` window will drop any live conversation and reboot Claude).
