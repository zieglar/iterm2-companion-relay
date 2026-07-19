// Server integration for the distributed-mode ownership gate (reject-on-doubt,
// §6.5): a real http+ws host is booted with an injected shard-map store, and the
// gate is exercised end-to-end over real sockets. This is where the ordering
// guarantees (reject BEFORE the attest limiter / body read / 101) that could not
// be unit-tested in admission.test.js are pinned. See docs/companion-relay-design.md.

import { describe, it, expect } from "vitest";
import { WebSocket } from "ws";
import { createRelay } from "../../host/server.js";

// Vector room whose bucket is 57888 (the box owns it); "f"*64 -> bucket 65535
// (not owned).
const OWNED_ROOM = "611c035897cf71eebc08e531616a3470f666cd001532e1bd4957dd762efae220";
const OWNED_BUCKET = 57888;
const UNOWNED_ROOM = "f".repeat(64);

const store = { ownsBucket: (b) => b === OWNED_BUCKET };

const DISTRIBUTED = {
  shardMapUrl: "https://cdn/shardmap.json",
  selfHost: "relay1",
  shardMapStore: store,
};

async function withRelay(options, fn) {
  const relay = createRelay({
    env: { RELAY_ORIGIN: "https://relay1", RELAY_LOG: "false", ATTEST_REQUIRED: "false" },
    dbPath: ":memory:",
    ...options,
  });
  await relay.listen(0, "127.0.0.1");
  const port = relay.address().port;
  try {
    await fn({ base: `http://127.0.0.1:${port}`, wsBase: `ws://127.0.0.1:${port}` });
  } finally {
    await relay.close();
  }
}

const post = (base, path, room, body = "") =>
  fetch(base + path, { method: "POST", headers: { "x-relay-room": room }, body });

// Resolve to { opened: true } if the upgrade completes, or { status } if it is
// rejected before the 101.
function wsAttempt(wsBase, room) {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsBase, { headers: { "x-relay-room": room } });
    const done = (v) => { try { ws.terminate(); } catch { /* ignore */ } resolve(v); };
    ws.on("open", () => done({ opened: true }));
    ws.on("unexpected-response", (_req, res) => done({ status: res.statusCode }));
    ws.on("error", () => { /* follows unexpected-response; ignore */ });
  });
}

describe("distributed mode: reject-on-doubt on the data plane", () => {
  it("rejects a non-owned WebSocket upgrade with 421 before the 101", async () => {
    await withRelay(DISTRIBUTED, async ({ wsBase }) => {
      expect(await wsAttempt(wsBase, UNOWNED_ROOM)).toEqual({ status: 421 });
    });
  });

  it("admits an owned WebSocket upgrade", async () => {
    await withRelay(DISTRIBUTED, async ({ wsBase }) => {
      expect(await wsAttempt(wsBase, OWNED_ROOM)).toEqual({ opened: true });
    });
  });

  it("rejects /attest, /register, /delete for a non-owned bucket with 421", async () => {
    await withRelay(DISTRIBUTED, async ({ base }) => {
      for (const path of ["/attest/challenge", "/attest", "/register", "/delete"]) {
        expect((await post(base, path, UNOWNED_ROOM)).status, path).toBe(421);
      }
    });
  });

  it("checks ownership BEFORE charging the /attest rate limiter", async () => {
    // Limit of 1: if a non-owned /attest charged the limiter, an owned /attest
    // afterward would be 429. It must not be.
    await withRelay({ ...DISTRIBUTED, attestLimit: { limit: 1, windowMs: 60_000 } }, async ({ base }) => {
      for (let i = 0; i < 3; i++) expect((await post(base, "/attest", UNOWNED_ROOM)).status).toBe(421);
      const owned = await post(base, "/attest", OWNED_ROOM);
      expect(owned.status).not.toBe(429); // limiter was never charged by the rejects
    });
  });

  it("prefers 421 (re-resolve) over 429 (retry-here) for a non-owned WS reconnect", async () => {
    // Per-IP ws limiter of 1: if it were charged before the ownership gate, the
    // second non-owned upgrade from the same IP would get 429 (stay here). The
    // gate must win, so both get 421 (re-resolve) during a reshard.
    await withRelay({ ...DISTRIBUTED, wsLimit: { limit: 1, windowMs: 60_000 } }, async ({ wsBase }) => {
      expect(await wsAttempt(wsBase, UNOWNED_ROOM)).toEqual({ status: 421 });
      expect(await wsAttempt(wsBase, UNOWNED_ROOM)).toEqual({ status: 421 });
    });
  });

  it("checks ownership BEFORE reading the body (oversized body -> 421, not 413)", async () => {
    await withRelay(DISTRIBUTED, async ({ base }) => {
      const big = "x".repeat(80 * 1024); // over MAX_BODY_BYTES (64 KiB)
      expect((await post(base, "/register", UNOWNED_ROOM, big)).status).toBe(421);
    });
  });
});

describe("direct mode (self-host): the gate is a no-op", () => {
  it("admits any room over WS and does not 421 on the HTTP data plane", async () => {
    await withRelay({}, async ({ base, wsBase }) => {
      expect(await wsAttempt(wsBase, UNOWNED_ROOM)).toEqual({ opened: true });
      expect((await post(base, "/attest", UNOWNED_ROOM)).status).not.toBe(421);
    });
  });
});
