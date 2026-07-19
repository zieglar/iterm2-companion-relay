// Which buckets a box owns from the map, and the acquired/relinquished diff on a
// reload. See docs/companion-relay-design.md (§6.5).

import { describe, it, expect } from "vitest";
import { ownedBuckets, diffOwned } from "../../src/sharding/ownedSet.js";

const N = 65536;
const map = (ranges) => ({ version: 1, ranges });
const r = (low, high, host) => ({ low, high, host });
const set = (...xs) => new Set(xs);

describe("ownedBuckets", () => {
  it("collects a single contiguous range", () => {
    const owned = ownedBuckets(map([r(0, 32767, "relay1"), r(32768, N - 1, "relay2")]), "relay1");
    expect(owned.size).toBe(32768);
    expect(owned.has(0)).toBe(true);
    expect(owned.has(32767)).toBe(true);
    expect(owned.has(32768)).toBe(false);
  });

  it("collects several disjoint arcs for one host (wrap arc)", () => {
    const owned = ownedBuckets(map([
      r(0, 5000, "relay1"),
      r(5001, 59999, "relay2"),
      r(60000, N - 1, "relay1"),
    ]), "relay1");
    expect(owned.size).toBe(5001 + (N - 60000)); // 5001 + 5536
    expect(owned.has(0)).toBe(true);
    expect(owned.has(5000)).toBe(true);
    expect(owned.has(5001)).toBe(false);
    expect(owned.has(59999)).toBe(false);
    expect(owned.has(60000)).toBe(true);
    expect(owned.has(N - 1)).toBe(true);
  });

  it("returns an empty set for a host that owns nothing", () => {
    const owned = ownedBuckets(map([r(0, N - 1, "relay1")]), "relay2");
    expect(owned.size).toBe(0);
  });
});

describe("diffOwned", () => {
  it("splits into acquired and relinquished", () => {
    const { acquired, relinquished } = diffOwned(set(0, 1, 2, 3), set(2, 3, 4, 5));
    expect([...acquired].sort((a, b) => a - b)).toEqual([4, 5]);
    expect([...relinquished].sort((a, b) => a - b)).toEqual([0, 1]);
  });

  it("is empty on both sides when the sets are equal", () => {
    const { acquired, relinquished } = diffOwned(set(1, 2, 3), set(1, 2, 3));
    expect(acquired.size).toBe(0);
    expect(relinquished.size).toBe(0);
  });

  it("treats a first assignment as all-acquired", () => {
    const { acquired, relinquished } = diffOwned(set(), set(7, 8, 9));
    expect([...acquired].sort((a, b) => a - b)).toEqual([7, 8, 9]);
    expect(relinquished.size).toBe(0);
  });

  it("treats a drain-to-empty as all-relinquished", () => {
    const { acquired, relinquished } = diffOwned(set(7, 8, 9), set());
    expect(acquired.size).toBe(0);
    expect([...relinquished].sort((a, b) => a - b)).toEqual([7, 8, 9]);
  });
});
