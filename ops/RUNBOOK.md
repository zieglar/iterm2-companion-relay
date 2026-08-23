# Monitor alerts — incident runbook

What to do when the relay monitor emails you, and the facts you need to triage
fast. Covers the alert classes the monitor (`monitor/`) can send and the
diagnostics that actually distinguish them.

> ⚠️ **Redacted for a public repo.** Identifying values (the relay's public
> origin, the monitor's public hostname, the alert email) are placeholders
> (`<relay-origin>`, `<monitor-host>`, `<alert-email>`). Substitute your own. The
> real values live in the monitor box's `monitor.env` (gitignored), never in the
> repo (see [Config lives locally](#config-lives-locally)).

---

## Architecture in one picture

```
  relay (Node, VPS) ──outbound push every ~1 min──▶ monitor /ingest ──▶ latest.json
   │  bin/relay.js                                   (Node, separate box)     │
   │  host/metricspush.js                                                     │
   │                              internal timer */5 ──▶ reads state, analyzes ┘
   │                                                     emails on liveness/cap/errors/
   │                                                     exceptions/anomaly
   │
   └──loopback /metrics (127.0.0.1:8788)──▶ on-box dashboard (independent path)
```

Two things to internalize:

- **The monitor is a self-hosted Node service on a separate box** (ideally a
  different hosting provider from the relays), not a Cloudflare Worker. It moved
  off Cloudflare because the per-push KV write cost blew the free-tier daily quota
  every afternoon (see [History: off Cloudflare](#history-off-cloudflare)). It
  watches the VPS relay via *pushed* metrics.
- **The push path and the dashboard path are independent.** The dashboard scrapes
  the relay's loopback `/metrics` locally, so it keeps working even when the
  outbound push to the monitor is failing. That split is a diagnostic lever
  (below).

---

## Alert: "Relay not reporting" (liveness / dead-man's-switch)

> `[CRITICAL] Relay not reporting` — *No fresh metrics from the relay: no snapshot
> for N min. The relay process or its host may be down.*

This means the monitor's stored snapshot went stale (`> STALE_MINUTES` old). It
fires on a **real relay/host outage** *or* on **the outbound push failing while
the relay is fine**. Distinguish them before assuming an outage — the second is
more common and looks identical from Cloudflare's side.

### Triage, in order

**1. Is the relay process actually up?**

```bash
systemctl status iterm2-companion-relay-cf     # active (running)?
ps -o pid,etime,cmd -C node | grep relay.js     # note the PID + uptime
```

A stable PID with long uptime = **the process never restarted**, so this is not a
crash. `Restart=always` means a crash would show a *recent* start time.

**2. Is it serving users right now?** Hit the loopback metrics (always available
if the process is healthy; never exposed to the internet):

```bash
curl -s http://127.0.0.1:8788/metrics | grep -E \
  'relay_sockets_live|relay_rooms_live|relay_ws_upgrades_total|relay_process_exceptions_total|relay_metrics_push_errors_total'
```

- `relay_sockets_live` / `relay_rooms_live` nonzero and `relay_ws_upgrades_total`
  climbing over a few seconds ⇒ **the relay is up and serving**. The alert is a
  *reporting* problem, not an outage. Go to step 3.
- Connection refused / no response ⇒ the relay really is down. Check
  `journalctl -u iterm2-companion-relay-cf` (needs root) for the crash, and
  `relay_process_exceptions_total` history in the dashboard.

**3. Are the outbound pushes failing?** Watch the push-error counter for ~2 min
(pushes happen every ~1 min; the counter should be flat):

```bash
for i in 1 2 3; do curl -s http://127.0.0.1:8788/metrics \
  | awk '/^relay_metrics_push_errors_total /{print systime(), $2}'; sleep 60; done
```

Counter **climbing ~once per push interval ⇒ ~100% of pushes are failing.** The
relay only *counts* failures (`host/server.js`: `onError: () =>
metrics.inc("metrics_push_errors_total")`) — it never logs the reason (logless
posture), so the reason must come from the monitor side (step 4).

**4. Why are pushes failing? Ask the monitor.** The monitor logs its own
operation to the journal (it handles no user traffic and stores no PII, so this
is safe). On the monitor box:

```bash
journalctl -u iterm2-relay-monitor -f        # then trigger one push (below)
```

Then reproduce a single push from the VPS with the real URL + token (needs root
to read the env):

```bash
sudo bash -c 'set -a; . /etc/iterm2-companion-relay-cf.env;
  curl -sS -X POST "$RELAY_METRICS_PUSH_URL" \
    -H "authorization: Bearer $RELAY_METRICS_PUSH_TOKEN" \
    -H "content-type: application/json" -d "{\"ts\":0}" \
    -o /dev/null -w "HTTP %{http_code}\n"'
```

Read the status code:

| Code | Meaning | Fix |
|------|---------|-----|
| **500** + journal shows an exception on `/ingest` | monitor bug or a full/unwritable `MONITOR_STATE_DIR` | check `journalctl -u iterm2-relay-monitor`; verify disk space and the StateDirectory perms |
| **401** | token mismatch: relay's `RELAY_METRICS_PUSH_TOKEN` ≠ monitor's `INGEST_TOKEN` | fix `INGEST_TOKEN` in the monitor's env (or the relay env) and restart the affected side |
| **404** | wrong URL/path (must end `/ingest`) | fix `RELAY_METRICS_PUSH_URL` |
| **502 / 000 / could not resolve** | Caddy down, monitor process down, or DNS/egress to `<monitor-host>` | check the monitor's Caddy + `iterm2-relay-monitor` unit; confirm VPS egress reaches the monitor host |
| **204** | the push actually works | failure is intermittent/network-timing; widen `STALE_MINUTES` |

### Historical root cause: KV free-tier write cap (resolved by moving off Cloudflare)

> **This can no longer happen.** The monitor used to be a Cloudflare Worker that
> wrote each push into KV, and the free plan caps KV at **1000 writes/day,
> account-wide**. One write per ~1-min push (1440/day) plus the cron's state
> write blew the cap every afternoon: every `/ingest` PUT then threw 500, the
> stored snapshot went stale, and the dead-man's-switch paged at the same time
> each day, resetting at 00:00 UTC. That recurring self-inflicted spam is why the
> monitor moved to a Node service backed by a local file, which has no write cap.
> If you see this pattern, you're running the old Worker; finish the migration.

**Still-relevant tuning:** `STALE_MINUTES` **must exceed** the push interval by a
comfortable margin, or normal jitter false-alarms. With a 1-min push, the shipped
`STALE_MINUTES=9` gives plenty of headroom (a genuinely dead relay is detected in
up to ~14 min: 9 + up to 5 min for the next timer tick). Tighten both together if
you want faster detection; there's no longer a write-cost reason to slow the push.

**Why you might still see only one email despite an all-day outage:**
`COOLDOWN_MINUTES=360` (6 h) suppresses repeats of the same alert key. A
persistent condition pages once, then goes quiet. Silence after a liveness alert
does **not** mean resolved.

---

## Alert: "Relay handshake failing" (synthetic probe)

The monitor also opens a **real WebSocket to the relay's public origin**
(`RELAY_PROBE_URL`) each cron run and drives a mac-park handshake. This alert
means that outside-in path is broken **even if the relay is up and pushing** —
i.e. the inbound serving chain (DNS → Cloudflare → origin firewall → reverse
proxy → WS upgrade → admission) is failing where the metrics push can't see it.

- **Liveness fired but probe did NOT** ⇒ the process/push side is the problem;
  inbound serving is fine (this was true in the July 2026 incident).
- **Probe fired but liveness did NOT** ⇒ process is up and pushing, but users
  can't connect. Check the origin firewall (`ops/cloudflare-origin-firewall.sh`,
  which pins inbound to current Cloudflare IPs and goes stale as those rotate),
  the reverse proxy, and DNS/proxy status for `<relay-origin>`.

**Sharded fleets: HTTP 421 on the probe is NOT a broken inbound path.** A
distributed-mode relay answers 421 (reject-on-doubt) for any room whose bucket
it does not own; that is the re-resolve signal working, and the same host will
answer 101 for a room it does own. Set `SHARD_MAP_URL` in `monitor.env` (see
`monitor.env.example`) so the probe fetches the live map and drives one
owned-room handshake against every host the map names; do not probe a sharded
host with a random room (it will "fail" with 421 in proportion to the ring it
does not own). First diagnostic on any probe 421: compare a WS upgrade with a
room the host owns vs one it does not (see `ops/SHARDING.md`); symmetric
101/421 means the host is healthy and the prober is shard-unaware.

---

## Other alerts (brief)

- **Capacity** (`Live sockets/rooms near cap`): approaching
  `SOCKETS_CAP`/`ROOMS_CAP`. Confirm on the dashboard; raise
  `RELAY_MAX_TOTAL_SOCKETS`/`RELAY_MAX_ROOMS` (and the monitor caps to match) or
  investigate a leak/abuse.
- **Error rate** (`Error rate N%`): HTTP 500s over the interval past
  `ERROR_RATIO` with an `ERROR_MIN_REQUESTS` floor. Check the dashboard for the
  spike; correlate with a deploy.
- **Process exceptions** (`Process exceptions: N`): the relay swallowed
  process-level exceptions to keep serving. Nonzero between checks is worth a
  look even though it self-recovered.
- **Traffic anomaly** (`Traffic spike/drop`): hourly requests vs the per-hour-of-
  week baseline. A **drop** can be an early outage signal; a **spike** can be
  abuse. Silent until the baseline has `MIN_SAMPLES` weeks — expect no anomaly
  alerts for the first couple of weeks after deploy.
- **Shard-map fetch errors** (`Shard-map fetch errors: N`): a distributed-mode
  relay failed to refresh `shardmap.json` since the last check. The relay keeps
  serving its **last-known-good** map (by design: never fail-open/closed), so
  nothing is down *yet*, but a host that cannot see map changes will not observe
  a reshard: it keeps serving buckets it no longer owns and never starts its
  drain. If it persists, fix the box's egress to the resolver; if it persists
  **across a reshard**, hard-stop the host to complete the drain. Full
  procedure: `ops/SHARDING.md`. (Direct-mode relays never fire this.)

---

## Not an alert: a user can't connect / client logs "1008 daily quota exceeded"

This one does **not** page. The relay process is healthy and keeps pushing, so
both liveness and the synthetic probe stay green — it surfaces instead as a
**user report** ("my Mac won't connect") whose client logs show the relay
closing the WebSocket with close code **1008**, reason **`daily quota
exceeded`**.

**Root cause.** Each room has a per-room **daily byte quota**: relayed bytes per
rolling 24h, code default **512 MiB** (`RELAY_DAILY_BYTE_QUOTA`, enforced in
`src/room.js` `overQuota`). A live terminal-sharing session (video stream +
history tiles) can blow 512 MiB in one long sitting. Once a room crosses the cap
it is torn down — **every** socket in that room is closed with `1008 daily quota
exceeded` — and the byte count is **persisted**, so the room keeps refusing until
its 24h window rolls. The relay sees only ciphertext; the cap is purely
abuse/cost protection, not correctness.

**Why it doesn't self-heal.** Neither app treats 1008 as terminal today: both
reconnect on a backoff, immediately relay a frame, re-trip the still-exhausted
quota, and get closed again — a silent all-day retry loop until the window resets
or the cap is raised. (App-side handling is tracked separately.)

**Triage.**

1. **Dashboard:** the **Quota closes** tile and **Quota closes /min** chart are
   nonzero and climbing. The counter increments once per
   severed socket, so a client stuck in the retry loop makes it ramp steadily —
   that ramp is the tell that someone is pinned against the cap right now.
2. **On the box**, find the offending room and when its window resets. `bytes`
   near the limit is the culprit; the window resets at `dayStart + 24h`:

   ```sh
   DB=$(sudo grep -E '^RELAY_DB=' /etc/iterm2-companion-relay-cf.env | cut -d= -f2-)
   sudo sqlite3 -readonly "$DB" \
     "SELECT room, json_extract(value,'\$.bytes') AS bytes,
             datetime(json_extract(value,'\$.dayStart')/1000,'unixepoch') AS window_start
      FROM kv WHERE key='quota' ORDER BY bytes DESC LIMIT 15;"
   ```

   `room` is an opaque hash, not the room name (zero PII).

**Fix.** Raise the cap and restart. The persisted byte count is then below the
new limit, so the room recovers on its **next frame** — no need to wait out the
window:

```sh
sudo sed -i -E '/^#?[[:space:]]*RELAY_DAILY_BYTE_QUOTA=/d' /etc/iterm2-companion-relay-cf.env
echo 'RELAY_DAILY_BYTE_QUOTA=8589934592' | sudo tee -a /etc/iterm2-companion-relay-cf.env   # 8 GiB
sudo systemctl restart iterm2-companion-relay-cf
```

Production runs **8 GiB** (carried in `ops/relay.env.example`); raise further if
legitimate sessions still hit it.

---

## Reference facts (the gotchas that cost time)

### Config lives locally

The monitor's config and secrets live in **`monitor.env` on the monitor box**
(installed as `/etc/iterm2-relay-monitor.env`, the systemd `EnvironmentFile`).
It's **gitignored**: it holds `INGEST_TOKEN`, `RESEND_API_KEY`, `ALERT_TO`, and
`RELAY_PROBE_URL` (the relay's public origin), none of which belong in a public
repo. Consequences:

- **Never commit `monitor.env`** — that would leak the shared push token, your
  Resend key, and the relay's public origin.
- Per-deploy values (like `STALE_MINUTES`) live only on the box. Change them
  there and `systemctl restart iterm2-relay-monitor`; they don't travel via git.
- The *rationale and safe defaults* are published in `monitor/monitor.env.example`
  and `ops/relay.env.example`, both normal tracked files.

### History: off Cloudflare

The monitor used to be a **Cloudflare Worker + KV** (`iterm2-relay-monitor`), with
config in a `skip-worktree` `monitor/wrangler.jsonc`. It was retired because the
per-push KV write cost blew the free-tier daily quota every afternoon (see
[the historical root cause](#historical-root-cause-kv-free-tier-write-cap-resolved-by-moving-off-cloudflare)),
turning the monitor itself into a daily source of spam. The analysis logic
(`monitor/src/monitor.js`) carried over unchanged; only the I/O shell (KV → local
file, cron → internal timer, Workers WebSocket → the `ws` package, `fetch`
handler → a Node HTTP server) was reimplemented.

Even earlier there was an Analytics-based monitor (`iterm2/Companion/RelayMonitor/`,
Cloudflare GraphQL) watching the original Worker relay; it has been deleted. If
you ever see a monitor that does *not* emit **"no snapshot for N min"** on a relay
outage, it's not this one.

### Where things are

| Thing | Location |
|-------|----------|
| Relay process | `iterm2-companion-relay-cf.service` → `bin/relay.js` |
| Relay env (real secrets) | `/etc/iterm2-companion-relay-cf.env` (root) |
| Relay loopback metrics | `http://127.0.0.1:8788/metrics` |
| Relay SQLite state (per-room quota/tickets) | `$RELAY_DB` (opaque room hashes; zero PII) |
| Outbound push code | `host/metricspush.js`, wired in `host/server.js` |
| On-box dashboard | `iterm2-relay-dashboard.service` → `bin/dashboard.js` (SQLite, loopback) |
| Monitor service (separate box) | `iterm2-relay-monitor.service` → `journalctl -u iterm2-relay-monitor`; state in `/var/lib/iterm2-relay-monitor` |
| Monitor analysis (unit-tested, pure) | `monitor/src/monitor.js` |

### Key constants (defaults)

- Push cadence: `RELAY_METRICS_PUSH_MS` = 60000 (1 min). Persisted to a local file
  on the monitor (no write cap).
- Staleness window: `STALE_MINUTES` = 9. Analysis timer: every 5 min
  (`MONITOR_INTERVAL_MS` = 300000).
- Alert cooldown: `COOLDOWN_MINUTES` = 360 (6 h); escalation warn→critical bypasses
  it.
- Per-room daily byte quota: `RELAY_DAILY_BYTE_QUOTA` = **8 GiB** in prod (code
  default 512 MiB). Trips → `1008 daily quota exceeded`, persisted for the rolling
  24h window; surfaced by the dashboard's **Quota closes** tile/chart
  (`relay_quota_exceeded_total`). See the quota section above.
