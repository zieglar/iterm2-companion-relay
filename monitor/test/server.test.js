// Integration tests for the Node I/O shell: the on-disk store, the HTTP surface
// (/ingest auth + per-host routing + operator endpoints), and the real ws probe
// handshake. The pure analysis and the fleet orchestration live in
// monitor.test.js (run() direct/fleet modes).

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";

import { fileStore } from "../src/store.js";
import { createServer, nodeProbe } from "../src/server.js";

const cleanups = [];
afterEach(() => { while (cleanups.length) cleanups.pop()(); });

function tmpDir() {
  const dir = mkdtempSync(join(tmpdir(), "relay-monitor-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Start an http server on an ephemeral port and return its base URL.
function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      cleanups.push(() => server.close());
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

describe("fileStore", () => {
  it("returns null for a missing key and round-trips JSON", async () => {
    const kv = fileStore(tmpDir());
    expect(await kv.get("latest", "json")).toBe(null);
    await kv.put("latest", JSON.stringify({ a: 1 }));
    expect(await kv.get("latest", "json")).toEqual({ a: 1 });
  });

  it("overwrites atomically on a second put", async () => {
    const kv = fileStore(tmpDir());
    await kv.put("state", JSON.stringify({ v: 1 }));
    await kv.put("state", JSON.stringify({ v: 2 }));
    expect(await kv.get("state", "json")).toEqual({ v: 2 });
  });
});

describe("createServer - /ingest", () => {
  const env = { INGEST_TOKEN: "tok", MANUAL_TRIGGER_SECRET: "opkey" };

  it("stores a bearer-authenticated direct-mode snapshot under 'latest' and 204s", async () => {
    const kv = fileStore(tmpDir());
    const base = await listen(createServer(env, { kv }));
    const res = await fetch(`${base}/ingest`, {
      method: "POST",
      headers: { authorization: "Bearer tok", "content-type": "application/json" },
      body: JSON.stringify({ http_requests_total: 5, sockets_live: 2 }),
    });
    expect(res.status).toBe(204);
    const stored = await kv.get("latest", "json");
    expect(stored.snapshot).toEqual({ http_requests_total: 5, sockets_live: 2 });
    expect(typeof stored.receivedAt).toBe("number");
  });

  it("stores a fleet per-host push under latest:<host>", async () => {
    const kv = fileStore(tmpDir());
    const base = await listen(createServer(env, { kv }));
    const res = await fetch(`${base}/ingest/relay1.iterm2.com`, {
      method: "POST",
      headers: { authorization: "Bearer tok", "content-type": "application/json" },
      body: JSON.stringify({ sockets_live: 3 }),
    });
    expect(res.status).toBe(204);
    const stored = await kv.get("latest:relay1.iterm2.com", "json");
    expect(stored.snapshot).toEqual({ sockets_live: 3 });
    // direct-mode key is untouched, so per-host sources never collide
    expect(await kv.get("latest", "json")).toBe(null);
  });

  it("rejects a malformed host in the ingest path with 400 (before reading the body)", async () => {
    const kv = fileStore(tmpDir());
    const base = await listen(createServer(env, { kv }));
    const res = await fetch(`${base}/ingest/bad_host!`, {
      method: "POST", headers: { authorization: "Bearer tok" }, body: "{}",
    });
    expect(res.status).toBe(400);
  });

  it("rejects a wrong or missing bearer token with 401 (both bare and per-host)", async () => {
    const base = await listen(createServer(env, { kv: fileStore(tmpDir()) }));
    const bad = await fetch(`${base}/ingest`, {
      method: "POST", headers: { authorization: "Bearer nope" }, body: "{}",
    });
    expect(bad.status).toBe(401);
    const none = await fetch(`${base}/ingest/relay1.iterm2.com`, { method: "POST", body: "{}" });
    expect(none.status).toBe(401);
  });

  it("400s on a malformed JSON body", async () => {
    const base = await listen(createServer(env, { kv: fileStore(tmpDir()) }));
    const res = await fetch(`${base}/ingest`, {
      method: "POST", headers: { authorization: "Bearer tok" }, body: "not json",
    });
    expect(res.status).toBe(400);
  });
});

describe("createServer - operator endpoints", () => {
  const env = { INGEST_TOKEN: "tok", MANUAL_TRIGGER_SECRET: "opkey", ALERT_FROM: "f", ALERT_TO: "t" };

  it("404s the dry-run without the operator key (no info leak)", async () => {
    const base = await listen(createServer(env, { kv: fileStore(tmpDir()) }));
    const res = await fetch(base);
    expect(res.status).toBe(404);
  });

  it("returns a dry-run analysis (per-host summaries + due) with the operator key", async () => {
    const kv = fileStore(tmpDir());
    await kv.put("latest", JSON.stringify({ receivedAt: Date.now(), snapshot: { sockets_live: 1 } }));
    const base = await listen(createServer(env, { kv }));
    const res = await fetch(base, { headers: { "x-monitor-key": "opkey" } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.hosts)).toBe(true);
    expect(body).toHaveProperty("due");
  });

  it("sends a test email via the injected sender on ?test=1", async () => {
    let sent = null;
    const sendEmail = async (_env, alerts) => { sent = alerts; };
    const base = await listen(createServer(env, { kv: fileStore(tmpDir()), sendEmail }));
    const res = await fetch(`${base}/?test=1`, { headers: { "x-monitor-key": "opkey" } });
    expect(res.status).toBe(200);
    expect((await res.json()).emailed).toBe(true);
    expect(sent[0].key).toBe("test");
  });
});

describe("nodeProbe (real ws handshake)", () => {
  it("drives the mac-park handshake and reports ok, sending a random room header", async () => {
    let seenRoom = null;
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    cleanups.push(() => wss.close());
    wss.on("connection", (ws, req) => {
      seenRoom = req.headers["x-relay-room"];
      ws.on("message", () => ws.send('{"ok":true}')); // second msg (empty proof) -> ok
      ws.send('{"nonce":"abc"}'); // first: the challenge
    });
    await new Promise((r) => wss.on("listening", r));
    const port = wss.address().port;

    const result = await nodeProbe(`http://127.0.0.1:${port}/`, 2000);
    expect(result.ok).toBe(true);
    expect(seenRoom).toMatch(/^[0-9a-f]{64}$/); // fresh 64-hex room on the header
  });

  it("reports the HTTP status when the upgrade is refused (broken inbound)", async () => {
    const { createServer: httpServer } = await import("node:http");
    const srv = httpServer((_req, res) => { res.writeHead(502).end("bad gateway"); });
    const base = await listen(srv);
    const result = await nodeProbe(`${base}/`, 2000);
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/502/);
  });

  it("accepts a caller-supplied owned room (fleet probes pass one)", async () => {
    let seenRoom = null;
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    cleanups.push(() => wss.close());
    wss.on("connection", (ws, req) => {
      seenRoom = req.headers["x-relay-room"];
      ws.on("message", () => ws.send('{"ok":true}'));
      ws.send('{"nonce":"abc"}');
    });
    await new Promise((r) => wss.on("listening", r));
    const room = "f".repeat(60) + "0abc";
    await nodeProbe(`http://127.0.0.1:${wss.address().port}/`, 2000, room);
    expect(seenRoom).toBe(room);
  });
});
