// iTerm2 relay monitor -- the Node I/O shell (replaces the Cloudflare Worker).
//
// Why this exists: on Cloudflare the relay's ~1/min metrics push was one KV
// write each, and KV's free tier caps writes at ~1000/day, so the monitor ran
// out of quota every afternoon and emailed about it. Running here, on a Linux
// box you control (ideally a DIFFERENT provider from the relays, so a provider
// outage can't take down both the relay and the thing that watches it), the
// snapshot lands in a local file with no write cap. No Cloudflare in the loop.
//
// It does everything the Worker did:
//   POST /ingest        (Authorization: Bearer INGEST_TOKEN)   <- the relay pushes here
//   GET  /              (x-monitor-key: MANUAL_TRIGGER_SECRET)  -> dry-run analysis JSON
//   GET  /?test=1       (x-monitor-key: MANUAL_TRIGGER_SECRET)  -> send a REAL test email
// plus an internal timer (MONITOR_INTERVAL_MS, default 5 min) that runs the same
// analysis the Worker's cron did.
//
// Run it behind Caddy (TLS) exactly like the relay: bind loopback here, let Caddy
// terminate 443 on the monitor's hostname and reverse-proxy /ingest. See
// ops/Caddyfile.example and ops/iterm2-relay-monitor.service.

import http from "node:http";
import { readFileSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { WebSocket } from "ws";

import { run, LATEST_KEY } from "./core.js";
import { probeHandshake, mapHosts, ownedRoomForHost } from "./monitor.js";
import { fileStore } from "./store.js";

// --- auth helpers ---

// Constant-time compare of two secrets supplied as strings. Length-guard first
// (timingSafeEqual throws on a length mismatch), then compare the bytes.
function secretEquals(a, expected) {
  if (!expected || typeof a !== "string") return false;
  const ab = Buffer.from(a);
  const eb = Buffer.from(expected);
  if (ab.length !== eb.length) return false;
  return timingSafeEqual(ab, eb);
}

function bearerOk(authHeader, expected) {
  const m = /^Bearer\s+(.+)$/i.exec(authHeader || "");
  return m ? secretEquals(m[1], expected) : false;
}

// --- outside-in synthetic probe (real WebSocket handshake) ---

// A fresh 64-hex room per probe, so it never touches a real pairing (and the
// throwaway room is evicted once idle). Matches the relay's ROOM_NAME_RE.
function randomRoom() {
  return randomBytes(32).toString("hex");
}

// Adapt the event-based `ws` socket to the { send, next, close } interface
// probeHandshake expects: buffer messages and hand them out one await at a time;
// a close/error before the next message rejects the pending read.
function wsAdapter(ws) {
  const queue = [];
  const waiters = [];
  const fail = (msg) => {
    const err = new Error(msg);
    while (waiters.length) waiters.shift().reject(err);
  };
  ws.on("message", (data) => {
    const s = typeof data === "string" ? data : data.toString("utf8");
    if (waiters.length) waiters.shift().resolve(s);
    else queue.push(s);
  });
  ws.on("close", () => fail("socket closed before reply"));
  ws.on("error", () => fail("socket error"));
  return {
    send: (s) => ws.send(s),
    next: () => new Promise((resolve, reject) => {
      if (queue.length) resolve(queue.shift());
      else waiters.push({ resolve, reject });
    }),
    close: () => { try { ws.close(); } catch { /* ignore */ } },
  };
}

// Open a WebSocket to the relay's public origin and drive the mac-park handshake
// the way a client would -- the room rides on the x-relay-room header, which is
// how the relay reads it (src/index.js ROOM_HEADER). A SINGLE deadline covers
// both the connect/upgrade and the handshake, because the headline failure this
// catches -- a stale firewall blackholing inbound -- stalls during connect, so
// the timeout must abort the connection, not just the handshake. Returns
// { ok, detail }; never rejects. originUrl is e.g. https://relay.iterm2.com/.
export async function nodeProbe(originUrl, timeoutMs, room = randomRoom()) {
  const wsUrl = originUrl.replace(/^http/i, "ws"); // https->wss, http->ws
  return new Promise((resolve) => {
    let settled = false;
    let ws;
    const done = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws && ws.close(); } catch { /* ignore */ }
      resolve(r);
    };
    const timer = setTimeout(
      () => done({ ok: false, detail: `timeout after ${timeoutMs}ms` }),
      timeoutMs,
    );
    try {
      ws = new WebSocket(wsUrl, {
        headers: { "x-relay-room": room },
        handshakeTimeout: timeoutMs,
      });
    } catch (e) {
      return done({ ok: false, detail: String((e && e.message) || e) });
    }
    ws.on("open", async () => {
      done(await probeHandshake(wsAdapter(ws)));
    });
    // A non-101 response (e.g. 502/403 from Caddy or the origin firewall) shows
    // up here rather than as a socket, and is exactly the broken-inbound signal.
    ws.on("unexpected-response", (_req, res) => {
      done({ ok: false, detail: `no websocket upgrade (HTTP ${res.statusCode})` });
    });
    ws.on("error", (e) => done({ ok: false, detail: String((e && e.message) || e) }));
  });
}

// Shard-aware fleet probe. With SHARD_MAP_URL set, fetch the live map and drive
// one owned-room handshake against EVERY host it names, so each host's inbound
// path is exercised with a room its ownership gate must admit. (A random room
// against a sharded host earns a correct HTTP 421 reject-on-doubt from every
// host that does not own that bucket, so on a fleet the old single-URL random
// probe false-pages against any host owning a small slice.) A host the map
// assigns nothing is a drained host, a normal state: skipped, not failed. A
// map that cannot be fetched or parsed IS a probe failure: the map is the
// pairing-critical resolution step, so if the monitor cannot resolve, clients
// likely cannot either. Without SHARD_MAP_URL this is the single-URL probe
// unchanged (direct-mode deployments).
// probeOne is injectable for tests; prod uses nodeProbe.
export async function fleetProbe({ probeUrl, shardMapUrl }, timeoutMs, probeOne = nodeProbe) {
  if (!shardMapUrl) return probeOne(probeUrl, timeoutMs);
  let map;
  try {
    const res = await fetch(shardMapUrl, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    map = JSON.parse(await res.text());
  } catch (e) {
    return { ok: false, detail: `shard map fetch failed: ${String((e && e.message) || e)}` };
  }
  const failures = [];
  const probed = [];
  for (const host of mapHosts(map)) {
    const room = ownedRoomForHost(map, host, randomBytes(30).toString("hex"), Math.random());
    if (!room) continue; // drained host: owns nothing, nothing to probe
    probed.push(host);
    const r = await probeOne(`https://${host}/`, timeoutMs, room);
    if (!r.ok) failures.push(`${host}: ${r.detail}`);
  }
  if (failures.length) return { ok: false, detail: failures.join("; ") };
  return { ok: true, detail: `map v${map.version}: ${probed.length} host(s) ok (${probed.join(", ")})` };
}

// --- email (Resend) ---

async function sendResend(env, alerts) {
  const worst = alerts.some((a) => a.severity === "critical") ? "CRITICAL" : "warning";
  const subject = `[iTerm2 relay] ${alerts.length} alert(s) (${worst})`;
  const text = alerts.map((a) => `[${a.severity.toUpperCase()}] ${a.title}\n${a.body}`).join("\n\n");
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from: env.ALERT_FROM, to: [env.ALERT_TO], subject, text }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
}

// --- env file loading (optional convenience for local `npm start`) ---

// Minimal KEY=VALUE loader so `node src/server.js monitor.env` works without a
// process manager. Under systemd you'd use EnvironmentFile= instead and skip the
// arg. Existing process.env always wins, so systemd/shell overrides take effect.
function loadEnvFile(file) {
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!(k in process.env)) process.env[k] = v;
  }
}

// --- HTTP server ---

function json(res, obj, status = 200) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body);
}

function readBody(req, limitBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function createServer(env, deps) {
  const { kv } = deps;
  return http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, "http://localhost");
    } catch {
      return json(res, { error: "bad url" }, 400);
    }

    // The relay pushes its snapshot here. Bearer-authenticated; the body is the
    // flat counter/gauge object from Metrics.snapshot().
    if (req.method === "POST" && url.pathname === "/ingest") {
      if (!bearerOk(req.headers.authorization, env.INGEST_TOKEN)) {
        return json(res, { error: "unauthorized" }, 401);
      }
      let snapshot;
      try {
        snapshot = JSON.parse(await readBody(req));
      } catch {
        return json(res, { error: "bad json" }, 400);
      }
      await kv.put(LATEST_KEY, JSON.stringify({ receivedAt: Date.now(), snapshot }));
      res.writeHead(204).end();
      return;
    }

    // Everything else is an operator tool, gated by the manual-trigger secret.
    if (req.method === "GET") {
      if (!secretEquals(req.headers["x-monitor-key"], env.MANUAL_TRIGGER_SECRET)) {
        return json(res, { error: "not found" }, 404);
      }
      if (url.searchParams.get("test") === "1") {
        try {
          await deps.sendEmail(env, [{
            key: "test", severity: "warn", title: "Relay monitor test",
            body: "If you received this, the monitor's email path works.",
          }]);
          return json(res, { emailed: true });
        } catch (e) {
          return json(res, { emailed: false, error: String((e && e.message) || e) }, 500);
        }
      }
      // Dry run: analyze the latest snapshot without sending mail or writing state.
      return json(res, await run(env, Date.now(), { ...deps, dry: true }));
    }

    return json(res, { error: "not found" }, 404);
  });
}

// --- entrypoint ---

// Guarded so importing this module in tests doesn't start a server or timer.
function main() {
  const envArg = process.argv[2];
  if (envArg) loadEnvFile(envArg);
  const env = process.env;

  for (const k of ["INGEST_TOKEN", "ALERT_FROM", "ALERT_TO", "RESEND_API_KEY"]) {
    if (!env[k]) {
      console.error(`relay-monitor: missing required env ${k}`);
      process.exit(1);
    }
  }

  const host = env.MONITOR_HOST || "127.0.0.1";
  const port = Number(env.MONITOR_PORT || 8790);
  const stateDir = env.MONITOR_STATE_DIR || "./data";
  const intervalMs = Number(env.MONITOR_INTERVAL_MS || 5 * 60 * 1000);

  const deps = { kv: fileStore(stateDir), runProbe: fleetProbe, sendEmail: sendResend };

  const tick = () => run(env, Date.now(), { ...deps, dry: false })
    .catch((e) => console.error("relay-monitor: tick failed:", (e && e.message) || e));

  const server = createServer(env, deps);
  server.listen(port, host, () => {
    console.error(`relay-monitor: listening on http://${host}:${port} (ingest + operator endpoints)`);
    console.error(`relay-monitor: analyzing every ${Math.round(intervalMs / 1000)}s; state in ${stateDir}`);
    tick(); // run once at startup so a fresh box surfaces problems immediately
    const timer = setInterval(tick, intervalMs);
    const shutdown = () => { clearInterval(timer); server.close(() => process.exit(0)); };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  });
}

// Start only when run directly (node src/server.js [envfile]), not when imported.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
