# iterm2-relay-monitor

A small **self-hosted Node service** that watches the relay and emails you when
something is wrong. Run it on a Linux box you control, ideally a **different
hosting provider from the relays**, so one provider's outage can't take down both
the relay and the thing that's supposed to notice.

It never touches user data: the relay pushes only aggregate, PII-free counts (the
same numbers `/metrics` exposes locally), so this preserves the relay's
zero-retention posture.

> **Why it moved off Cloudflare.** This used to be a scheduled Cloudflare Worker
> backed by KV. The relay's ~1/min metrics push was one KV write each, and the KV
> free tier caps writes at ~1000/day, so the monitor ran out of quota every
> afternoon and emailed *about that*. A local file has no write cap, so that whole
> class of noise is gone, and there's no Cloudflare in the loop.

## How it works (push, not scrape)

Data flows **outbound** from the relay, so the relay exposes **no** metrics
endpoint to the internet and never reveals its origin hostname:

```
relay  ──POST snapshot + Bearer INGEST_TOKEN──▶  monitor /ingest ──▶ latest.json
                                                     │
                     internal timer every 5 min ─────┤
                                                     ▼
                            read state → diff → analyze → Resend email
```

The relay pushes a snapshot every ~1-4 min (`RELAY_METRICS_PUSH_*`, see the
relay's `SELF-HOSTING.md`). An internal timer analyzes the latest snapshot,
diffs it against the previous one, and raises alerts.

## Two layers: push (inside-out) + probe (outside-in)

The push tells you the relay **process** is alive and reporting, but not that a
phone can actually **pair** - the snapshot travels relay → monitor and never
exercises the inbound path (DNS, TLS, origin firewall, proxy, WS upgrade,
admission). A relay can be up and pushing while every pairing fails.

So each tick also does an **outside-in synthetic probe**: it opens a real
WebSocket to the relay's public origin and drives a mac-park pairing handshake,
exactly as a client would. Success means the whole serving path works; failure
(`probe` alert) means inbound is broken even though the process is up. A fresh
random room is used each time, so it never touches a real pairing. Set
`RELAY_PROBE_URL` to enable it (unset = push-only).

## What it alerts on

| Alert | Layer | Condition |
|---|---|---|
| **Liveness** (dead-man's-switch) | push | No fresh snapshot within `STALE_MINUTES`. A down/wedged relay stops pushing, so silence is the signal. |
| **Handshake** (`probe`) | probe | The synthetic mac-park handshake to `RELAY_PROBE_URL` failed - the inbound serving path is broken. |
| **Capacity** | push | Live sockets/rooms cross `CAP_WARN_FRAC` / `CAP_CRIT_FRAC` of the configured caps. |
| **Error rate** | push | HTTP 500s / requests over the interval exceeds `ERROR_RATIO` (with a volume floor). |
| **Exceptions** | push | Swallowed process exceptions over the interval reach `EXCEPTION_THRESHOLD`. |
| **Shard-map fetch** | push | Distributed mode: the relay can't refresh the shard map (`SHARD_FETCH_THRESHOLD`). Always 0 in direct mode. |
| **Traffic anomaly** | push | Hourly request volume ≥ `SPIKE_FACTOR`× or ≤ `DROP_FACTOR`× the per-hour-of-week baseline. |

Probe coverage caveat: a fresh mac-park skips App Attest, and the probe doesn't
drive the phone half or the splice - so it catches the big inbound outages (DNS,
TLS, firewall, proxy, upgrade, basic admission), not attestation- or
phone-specific breakage.

Alerts are deduped with a per-condition cooldown (`COOLDOWN_MINUTES`); an
escalation from warning to critical bypasses the cooldown, and a condition that
clears re-pages if it recurs.

## Deploy

On the monitoring box (Debian/Ubuntu shown; Node 20+ and Caddy assumed):

```sh
sudo mkdir -p /opt/iterm2-relay-monitor
# copy this monitor/ directory there (git clone the repo, or scp/rsync), then:
cd /opt/iterm2-relay-monitor
sudo npm ci --omit=dev

# config + secrets
sudo cp monitor.env.example /etc/iterm2-relay-monitor.env
sudo $EDITOR /etc/iterm2-relay-monitor.env   # set INGEST_TOKEN, RESEND_API_KEY,
                                             # ALERT_*, MANUAL_TRIGGER_SECRET,
                                             # RELAY_PROBE_URL, caps

# service
sudo cp ops/iterm2-relay-monitor.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now iterm2-relay-monitor

# TLS front door for /ingest
sudo cp ops/Caddyfile.example /etc/caddy/Caddyfile   # edit the hostname, merge into yours
sudo systemctl reload caddy
```

Generate the shared secret with `openssl rand -hex 32`. Then point the relay at
this box - in the relay's env file:

```sh
RELAY_METRICS_PUSH_URL=https://monitor.yourdomain.com/ingest
RELAY_METRICS_PUSH_TOKEN=<the same value as INGEST_TOKEN>
# RELAY_METRICS_PUSH_MS=60000   # optional; a local file has no KV write cap, so
                                # 60s is fine again (KV had forced 240000).
```

### Run it without systemd / for local testing

```sh
cp monitor.env.example monitor.env   # fill in; gitignored
npm start monitor.env                # or: node src/server.js monitor.env
```

## Verify after deploy

```sh
# Dry run: fetch + analyze the latest snapshot, no email, no state write.
curl -s -H "x-monitor-key: $MANUAL_TRIGGER_SECRET" https://monitor.yourdomain.com/ | jq

# Send a real test email end to end (checks the Resend path).
curl -s -H "x-monitor-key: $MANUAL_TRIGGER_SECRET" "https://monitor.yourdomain.com/?test=1"
```

The dry run's `ageMs` shows how long ago the last snapshot arrived - a small
number means pushes are flowing. Right after first bringing up the relay side,
wait one push interval for the first snapshot; until then the monitor reports
"relay not reporting" (expected on a brand-new box).

## Test

```sh
npm test    # vitest: pure analysis core + the store, HTTP, and ws-probe shell
```

## Layout

- `src/monitor.js` - pure analysis: liveness, capacity, error, exception, shard,
  and anomaly checks; interval diffing; cooldown. No I/O.
- `src/core.js` - one tick's orchestration (state in, checks, delivery out), with
  storage / probe / email injected so it stays unit-tested without a network.
- `src/store.js` - the on-disk key/value store (atomic JSON files) that replaced KV.
- `src/server.js` - the Node I/O shell: the HTTP server (`/ingest` + operator
  endpoints), the analysis timer, the real `ws` probe, and Resend email.
- `monitor.env.example` - all config + secrets, documented inline.
- `ops/iterm2-relay-monitor.service` - hardened systemd unit.
- `ops/Caddyfile.example` - TLS front door for `/ingest`.
