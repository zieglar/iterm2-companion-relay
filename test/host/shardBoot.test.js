// Server integration for distributed-mode boot: createRelay builds its own
// shard-map store + poller from config, fetches the map BEFORE accepting
// connections (retrying if the first fetch fails), then gates by ownership.
// See docs/companion-relay-design.md (§6.5, §6.8).

import { describe, it, expect } from "vitest";
import { WebSocket } from "ws";
import { createRelay } from "../../host/server.js";

const N = 65536;
// relay1 owns [50000, 65535]; OWNED_ROOM bucket 57888 falls in it, UNOWNED bucket 0 does not.
const OWNED_ROOM = "611c035897cf71eebc08e531616a3470f666cd001532e1bd4957dd762efae220";
const UNOWNED_ROOM = "0".repeat(64);
const MAP_JSON = JSON.stringify({
  version: 7,
  ranges: [
    { low: 0, high: 49999, host: "relay2" },
    { low: 50000, high: N - 1, host: "relay1" },
  ],
});

async function boot(fetchText, extra = {}) {
  const relay = createRelay({
    env: { RELAY_ORIGIN: "https://relay1", RELAY_LOG: "false", ATTEST_REQUIRED: "false" },
    dbPath: ":memory:",
    shardMapUrl: "https://cdn/shardmap.json",
    selfHost: "relay1",
    fetchText,
    bootSleep: async () => {}, // no real delay between boot retries
    ...extra,
  });
  await relay.listen(0, "127.0.0.1");
  const port = relay.address().port;
  return { relay, base: `http://127.0.0.1:${port}`, wsBase: `ws://127.0.0.1:${port}` };
}

function wsAttempt(wsBase, room) {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsBase, { headers: { "x-relay-room": room } });
    const done = (v) => { try { ws.terminate(); } catch { /* ignore */ } resolve(v); };
    ws.on("open", () => done({ opened: true }));
    ws.on("unexpected-response", (_req, res) => done({ status: res.statusCode }));
    ws.on("error", () => {});
  });
}

describe("distributed boot", () => {
  it("fetches the map before accepting, then gates by ownership", async () => {
    const { relay, wsBase } = await boot(async () => MAP_JSON);
    try {
      expect(relay.shardStore.hasMap).toBe(true);
      expect(relay.shardStore.version).toBe(7);
      expect(await wsAttempt(wsBase, OWNED_ROOM)).toEqual({ opened: true });
      expect(await wsAttempt(wsBase, UNOWNED_ROOM)).toEqual({ status: 421 });
    } finally {
      await relay.close();
    }
  });

  it("renders the shard gauges on /metrics", async () => {
    const { relay, base } = await boot(async () => MAP_JSON);
    try {
      const text = await (await fetch(base + "/metrics")).text();
      expect(text).toContain("relay_shard_map_version 7");
      expect(text).toContain("relay_shard_owned_buckets 15536"); // [50000, 65535]
      expect(text).toContain("relay_shard_draining_buckets 0");
    } finally {
      await relay.close();
    }
  });

  it("fails to start (bounded) when the map never fetches, instead of hanging", async () => {
    const relay = createRelay({
      env: { RELAY_ORIGIN: "https://relay1", RELAY_LOG: "false" },
      dbPath: ":memory:",
      shardMapUrl: "https://cdn/shardmap.json",
      selfHost: "relay1",
      fetchText: async () => { throw new Error("ECONNREFUSED"); },
      bootSleep: async () => {},
      bootMaxRetries: 3,
    });
    await expect(relay.listen(0, "127.0.0.1")).rejects.toThrow();
    await relay.close().catch(() => {});
  });

  it("retries the boot fetch until the first map is adopted", async () => {
    let calls = 0;
    const fetchText = async () => {
      calls += 1;
      if (calls < 3) throw new Error("ECONNREFUSED"); // fail the first two
      return MAP_JSON;
    };
    const { relay, wsBase } = await boot(fetchText);
    try {
      expect(calls).toBeGreaterThanOrEqual(3);
      expect(relay.shardStore.hasMap).toBe(true);
      expect(await wsAttempt(wsBase, OWNED_ROOM)).toEqual({ opened: true });
    } finally {
      await relay.close();
    }
  });
});

describe("distributed config validation (createRelay fails fast)", () => {
  const env = { RELAY_ORIGIN: "https://relay1", RELAY_LOG: "false" };
  const store = { ownsBucket: () => true };

  it("throws when only one of shardMapUrl / selfHost is set", () => {
    expect(() => createRelay({ env, dbPath: ":memory:", shardMapUrl: "https://cdn/shardmap.json" })).toThrow();
    expect(() => createRelay({ env, dbPath: ":memory:", selfHost: "relay1" })).toThrow();
  });

  it("throws when RELAY_ORIGIN does not equal https:// + selfHost", () => {
    expect(() => createRelay({
      env: { RELAY_ORIGIN: "https://wrong-host" }, dbPath: ":memory:",
      shardMapUrl: "https://cdn/shardmap.json", selfHost: "relay1", shardMapStore: store,
    })).toThrow();
  });

  it("throws when the drain delay is under 2x the poll interval", () => {
    expect(() => createRelay({
      env, dbPath: ":memory:",
      shardMapUrl: "https://cdn/shardmap.json", selfHost: "relay1", shardMapStore: store,
      pollIntervalMs: 10_000, drainDelayMs: 15_000,
    })).toThrow();
  });

  it("does not throw for a valid distributed config", () => {
    expect(() => createRelay({
      env, dbPath: ":memory:",
      shardMapUrl: "https://cdn/shardmap.json", selfHost: "relay1", shardMapStore: store,
    })).not.toThrow();
  });
});
