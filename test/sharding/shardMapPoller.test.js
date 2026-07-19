// The poller: fetch -> parse -> validate -> store, with last-known-good on any
// failure. See docs/companion-relay-design.md (§6.5, §6.6, §6.8).

import { describe, it, expect, vi } from "vitest";
import { ShardMapPoller } from "../../src/sharding/shardMapPoller.js";
import { ShardMapStore } from "../../src/sharding/shardMapStore.js";

const N = 65536;
const mapJson = (version, ranges) => JSON.stringify({ version, ranges });
const whole = (version, host) => mapJson(version, [{ low: 0, high: N - 1, host }]);
const split = (version, selfHigh, self, other) =>
  mapJson(version, [{ low: 0, high: selfHigh, host: self }, { low: selfHigh + 1, high: N - 1, host: other }]);

// A fetchText that yields queued responses; a response may be a string (body) or
// an Error (thrown to simulate a network failure).
function queuedFetch(responses) {
  let i = 0;
  return async () => {
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    if (r instanceof Error) throw r;
    return r;
  };
}

const makePoller = (store, responses, extra = {}) =>
  new ShardMapPoller({ url: "https://cdn/shardmap.json", fetchText: queuedFetch(responses), store, ...extra });

describe("ShardMapPoller.fetchOnce", () => {
  it("adopts a valid newer map and fires onAdopt", async () => {
    const store = new ShardMapStore({ selfHost: "relay1" });
    const onAdopt = vi.fn();
    const res = await makePoller(store, [split(5, 32767, "relay1", "relay2")], { onAdopt }).fetchOnce();
    expect(res.ok).toBe(true);
    expect(res.adopted).toBe(true);
    expect(res.version).toBe(5);
    expect(store.version).toBe(5);
    expect(store.ownsBucket(0)).toBe(true);
    expect(onAdopt).toHaveBeenCalledOnce();
  });

  it("reports ok-but-not-adopted for an older map, without firing onAdopt", async () => {
    const store = new ShardMapStore({ selfHost: "relay1" });
    const onAdopt = vi.fn();
    const poller = makePoller(store, [whole(5, "relay1"), whole(4, "relay1")], { onAdopt });
    await poller.fetchOnce();
    const res = await poller.fetchOnce();
    expect(res.ok).toBe(true);
    expect(res.adopted).toBe(false);
    expect(store.version).toBe(5);
    expect(onAdopt).toHaveBeenCalledOnce(); // only the first
  });

  it("keeps last-known-good on a network error and fires onError", async () => {
    const store = new ShardMapStore({ selfHost: "relay1" });
    const onError = vi.fn();
    const poller = makePoller(store, [whole(5, "relay1"), new Error("ECONNREFUSED")], { onError });
    await poller.fetchOnce();
    const res = await poller.fetchOnce();
    expect(res.ok).toBe(false);
    expect(res.stage).toBe("fetch");
    expect(store.version).toBe(5); // unchanged
    expect(store.ownsBucket(0)).toBe(true);
    expect(onError).toHaveBeenCalledOnce();
  });

  it("keeps last-known-good on malformed JSON", async () => {
    const store = new ShardMapStore({ selfHost: "relay1" });
    const poller = makePoller(store, [whole(5, "relay1"), "{not json"]);
    await poller.fetchOnce();
    const res = await poller.fetchOnce();
    expect(res.ok).toBe(false);
    expect(res.stage).toBe("parse");
    expect(store.version).toBe(5);
  });

  it("does NOT adopt a fetched-but-invalid map (gap), keeping the good one", async () => {
    const store = new ShardMapStore({ selfHost: "relay1" });
    // v6 has a gap (bucket 101 uncovered): must be rejected, store stays on v5.
    const invalid = mapJson(6, [{ low: 0, high: 100, host: "relay1" }, { low: 102, high: N - 1, host: "relay2" }]);
    const poller = makePoller(store, [whole(5, "relay1"), invalid]);
    await poller.fetchOnce();
    const res = await poller.fetchOnce();
    expect(res.ok).toBe(false);
    expect(res.stage).toBe("parse");
    expect(store.version).toBe(5);
    expect(store.ownsBucket(0)).toBe(true);
  });

  it("never rejects, even on a thrown fetch", async () => {
    const store = new ShardMapStore({ selfHost: "relay1" });
    await expect(makePoller(store, [new Error("boom")]).fetchOnce()).resolves.toMatchObject({ ok: false });
  });
});

describe("ShardMapPoller.start/stop", () => {
  it("polls on an interval via an injected timer and stops cleanly", async () => {
    const store = new ShardMapStore({ selfHost: "relay1" });
    const poller = makePoller(store, [whole(5, "relay1")]);
    const spy = vi.spyOn(poller, "fetchOnce");
    let fn;
    const fakeSetInterval = vi.fn((cb) => { fn = cb; return 123; });
    poller.start(10_000, { setInterval: fakeSetInterval });
    expect(fakeSetInterval).toHaveBeenCalledWith(expect.any(Function), 10_000);
    fn(); fn();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(() => poller.stop()).not.toThrow();
  });
});
