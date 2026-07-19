// The shard-map state machine: monotonic adopt, last-known-good on error, and
// own-nothing as a valid drain state. See docs/companion-relay-design.md
// (§6.5, §6.6, §6.8).

import { describe, it, expect } from "vitest";
import { ShardMapStore } from "../../src/sharding/shardMapStore.js";

const N = 65536;
const r = (low, high, host) => ({ low, high, host });
const map = (version, ranges) => ({ version, ranges });

// A two-host map where `self` owns [0, split-1].
const splitMap = (version, split, self, other) =>
  map(version, [r(0, split - 1, self), r(split, N - 1, other)]);

describe("ShardMapStore: initial state", () => {
  it("has no map and owns nothing before any fetch", () => {
    const s = new ShardMapStore({ selfHost: "relay1" });
    expect(s.hasMap).toBe(false);
    expect(s.version).toBe(-1);
    expect(s.ownedBuckets().size).toBe(0);
    expect(s.ownsBucket(0)).toBe(false);
  });
});

describe("ShardMapStore: adopt and diff", () => {
  it("adopts the first map and reports all owned buckets as acquired", () => {
    const s = new ShardMapStore({ selfHost: "relay1" });
    const res = s.applyFetched(splitMap(5, 32768, "relay1", "relay2"));
    expect(res.adopted).toBe(true);
    expect(res.acquired.size).toBe(32768);
    expect(res.relinquished.size).toBe(0);
    expect(s.hasMap).toBe(true);
    expect(s.version).toBe(5);
    expect(s.ownsBucket(0)).toBe(true);
    expect(s.ownsBucket(32768)).toBe(false);
  });

  it("reports acquired and relinquished across an ownership change", () => {
    const s = new ShardMapStore({ selfHost: "relay1" });
    s.applyFetched(splitMap(5, 32768, "relay1", "relay2")); // owns [0, 32767]
    const res = s.applyFetched(splitMap(6, 16384, "relay1", "relay2")); // owns [0, 16383]
    expect(res.adopted).toBe(true);
    expect(res.acquired.size).toBe(0);
    expect(res.relinquished.size).toBe(32768 - 16384); // gave up [16384, 32767]
    expect(res.relinquished.has(16384)).toBe(true);
    expect(res.relinquished.has(32767)).toBe(true);
    expect(s.ownsBucket(16384)).toBe(false);
  });
});

describe("ShardMapStore: monotonic versioning", () => {
  it("ignores an equal or older version and leaves state unchanged", () => {
    const s = new ShardMapStore({ selfHost: "relay1" });
    s.applyFetched(splitMap(5, 32768, "relay1", "relay2"));

    const older = s.applyFetched(splitMap(4, 16384, "relay1", "relay2"));
    expect(older.adopted).toBe(false);
    expect(older.acquired.size).toBe(0);
    expect(older.relinquished.size).toBe(0);

    const equal = s.applyFetched(splitMap(5, 16384, "relay1", "relay2"));
    expect(equal.adopted).toBe(false);

    // Still on v5's ownership: owns [0, 32767].
    expect(s.version).toBe(5);
    expect(s.ownsBucket(16384)).toBe(true);
  });
});

describe("ShardMapStore: last-known-good on error", () => {
  it("keeps the adopted map when a fetch fails", () => {
    const s = new ShardMapStore({ selfHost: "relay1" });
    s.applyFetched(splitMap(5, 32768, "relay1", "relay2"));
    s.applyFetchError();
    expect(s.version).toBe(5);
    expect(s.hasMap).toBe(true);
    expect(s.ownsBucket(0)).toBe(true);
  });
});

describe("ShardMapStore: own-nothing is a valid drain state", () => {
  it("adopts a map that assigns this host no buckets and relinquishes all", () => {
    const s = new ShardMapStore({ selfHost: "relay1" });
    s.applyFetched(splitMap(5, 32768, "relay1", "relay2")); // owns [0, 32767]
    const res = s.applyFetched(map(6, [r(0, N - 1, "relay2")])); // relay1 owns nothing
    expect(res.adopted).toBe(true);
    expect(res.relinquished.size).toBe(32768);
    expect(res.acquired.size).toBe(0);
    // Distinct from the initial no-map state: a map IS adopted, it just owns nothing.
    expect(s.hasMap).toBe(true);
    expect(s.version).toBe(6);
    expect(s.ownedBuckets().size).toBe(0);
    expect(s.ownsBucket(0)).toBe(false);
  });
});
