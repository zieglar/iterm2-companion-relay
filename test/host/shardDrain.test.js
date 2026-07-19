// Server integration for gradual eviction (§7.4): a live room whose bucket is
// relinquished is drained (both sockets closed with WS 4421 + a `reshard`
// reason) after the defer, so the endpoints re-resolve. Driven by an injected
// clock and a manual scheduler run() so it is deterministic and never sleeps.
// See docs/companion-relay-design.md (§7.4).

import { describe, it, expect } from "vitest";
import { WebSocket } from "ws";
import { createRelay } from "../../host/server.js";

const N = 65536;
const OWNED_ROOM = "611c035897cf71eebc08e531616a3470f666cd001532e1bd4957dd762efae220";
const OWNED_BUCKET = 57888;
const MAP_JSON = JSON.stringify({
  version: 7,
  ranges: [{ low: 0, high: 49999, host: "relay2" }, { low: 50000, high: N - 1, host: "relay1" }],
});

describe("distributed drain", () => {
  it("evicts a relinquished bucket's live room with WS 4421 after the defer", async () => {
    const clock = { t: 0 };
    const relay = createRelay({
      env: { RELAY_ORIGIN: "https://relay1", RELAY_LOG: "false", ATTEST_REQUIRED: "false" },
      dbPath: ":memory:",
      shardMapUrl: "https://cdn/shardmap.json",
      selfHost: "relay1",
      fetchText: async () => MAP_JSON,
      now: () => clock.t,
      drainDelayMs: 20_000,
      evictionRate: 10,
    });
    await relay.listen(0, "127.0.0.1");
    const port = relay.address().port;
    const wsBase = `ws://127.0.0.1:${port}`;

    try {
      // Open a live socket for the owned room and wait until it is registered.
      const ws = new WebSocket(wsBase, { headers: { "x-relay-room": OWNED_ROOM } });
      const closed = new Promise((resolve) =>
        ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() })));
      await new Promise((resolve, reject) => {
        ws.on("open", resolve);
        ws.on("error", reject);
      });

      // The room is now a live splice in the owned bucket.
      expect(relay.runtime.roomsInBucket(OWNED_BUCKET)).toContain(OWNED_ROOM);

      // A reshard relinquishes the bucket at t=0 (deadline 20000).
      relay.shardDrain.relinquish(OWNED_BUCKET);

      // Before the deadline: no eviction.
      clock.t = 19_000;
      relay.shardDrain.run();
      expect(ws.readyState).toBe(WebSocket.OPEN);

      // After the deadline: the room is evicted with 4421 + "reshard".
      clock.t = 21_000;
      relay.shardDrain.run();
      const ev = await closed;
      expect(ev.code).toBe(4421);
      expect(ev.reason).toBe("reshard");
    } finally {
      await relay.close();
    }
  });

  it("cancels the drain if the bucket is re-acquired before the deadline", async () => {
    const clock = { t: 0 };
    const relay = createRelay({
      env: { RELAY_ORIGIN: "https://relay1", RELAY_LOG: "false", ATTEST_REQUIRED: "false" },
      dbPath: ":memory:",
      shardMapUrl: "https://cdn/shardmap.json",
      selfHost: "relay1",
      fetchText: async () => MAP_JSON,
      now: () => clock.t,
      drainDelayMs: 20_000,
      evictionRate: 10,
    });
    await relay.listen(0, "127.0.0.1");
    const port = relay.address().port;
    const wsBase = `ws://127.0.0.1:${port}`;

    try {
      const ws = new WebSocket(wsBase, { headers: { "x-relay-room": OWNED_ROOM } });
      await new Promise((resolve, reject) => { ws.on("open", resolve); ws.on("error", reject); });

      relay.shardDrain.relinquish(OWNED_BUCKET);
      clock.t = 5_000;
      relay.shardDrain.reacquire(OWNED_BUCKET); // re-acquired: never move its rooms
      clock.t = 60_000;
      relay.shardDrain.run();

      expect(ws.readyState).toBe(WebSocket.OPEN);
      expect(relay.shardDrain.drainingBuckets.has(OWNED_BUCKET)).toBe(false);
      ws.terminate();
    } finally {
      await relay.close();
    }
  });
});
