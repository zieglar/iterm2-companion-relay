// The gradual-eviction / drain scheduler (§7.4), driven by a virtual clock so it
// is deterministic and never sleeps. See docs/companion-relay-design.md (§7.4).

import { describe, it, expect } from "vitest";
import { DrainScheduler } from "../../src/sharding/drainScheduler.js";

// A test harness with a settable virtual clock, an evict spy, and a per-bucket
// live-room registry that drops rooms as they are evicted (like the real runtime).
function harness({ drainDelayMs = 20_000, evictionRatePerSec = 10 } = {}) {
  let t = 0;
  const evicted = [];
  const rooms = new Map(); // bucket -> Set(roomId)
  const sched = new DrainScheduler({
    drainDelayMs,
    evictionRatePerSec,
    now: () => t,
    evict: (id) => { evicted.push(id); for (const s of rooms.values()) s.delete(id); },
    liveRooms: (bucket) => [...(rooms.get(bucket) ?? [])],
  });
  return {
    sched,
    evicted,
    setTime: (ms) => { t = ms; },
    addRooms: (bucket, ids) => { rooms.set(bucket, new Set([...(rooms.get(bucket) ?? []), ...ids])); },
  };
}

const nRooms = (bucket, count) => Array.from({ length: count }, (_, i) => `${bucket}:r${i}`);

describe("DrainScheduler: defer", () => {
  it("evicts nothing before the drain deadline", () => {
    const h = harness();
    h.addRooms(1, nRooms(1, 50));
    h.sched.relinquish(1); // deadline = 20000
    for (const t of [0, 1000, 10000, 19999]) { h.setTime(t); h.sched.run(); }
    expect(h.evicted).toEqual([]);
  });
});

describe("DrainScheduler: rate-limited eviction after the deadline", () => {
  it("evicts at most one second's worth as the initial burst, then paces", () => {
    const h = harness({ drainDelayMs: 20_000, evictionRatePerSec: 10 });
    h.addRooms(1, nRooms(1, 100));
    h.sched.relinquish(1);

    h.setTime(20_000); h.sched.run();
    expect(h.evicted.length).toBe(10);          // burst capped at the rate

    h.setTime(21_000); h.sched.run();
    expect(h.evicted.length).toBe(20);          // +10 over the next second

    h.setTime(21_500); h.sched.run();
    expect(h.evicted.length).toBe(25);          // +5 over half a second
  });

  it("drains the bucket fully, evicting each room exactly once", () => {
    const h = harness({ drainDelayMs: 20_000, evictionRatePerSec: 10 });
    h.addRooms(1, nRooms(1, 100));
    h.sched.relinquish(1);
    for (let t = 20_000; t <= 40_000; t += 1_000) { h.setTime(t); h.sched.run(); }
    expect(h.evicted.length).toBe(100);
    expect(new Set(h.evicted).size).toBe(100);  // no double-eviction
  });

  it("never re-evicts a room even if it lingers in the live set", () => {
    const h = harness({ drainDelayMs: 20_000, evictionRatePerSec: 10 });
    // A liveRooms that always returns the same id (evict does not remove it).
    let t = 0;
    const evicted = [];
    const sched = new DrainScheduler({
      drainDelayMs: 20_000, evictionRatePerSec: 10,
      now: () => t, evict: (id) => evicted.push(id), liveRooms: () => ["stuck"],
    });
    sched.relinquish(1);
    for (const ms of [20_000, 21_000, 22_000]) { t = ms; sched.run(); }
    expect(evicted).toEqual(["stuck"]);
  });
});

describe("DrainScheduler: cancel on re-acquire", () => {
  it("cancels a drain scheduled but not yet started", () => {
    const h = harness();
    h.addRooms(1, nRooms(1, 50));
    h.sched.relinquish(1);
    h.setTime(5_000); h.sched.reacquire(1);
    h.setTime(60_000); h.sched.run();
    expect(h.evicted).toEqual([]);
    expect(h.sched.drainingBuckets.has(1)).toBe(false);
  });

  it("stops a drain already in progress", () => {
    const h = harness({ drainDelayMs: 20_000, evictionRatePerSec: 10 });
    h.addRooms(1, nRooms(1, 100));
    h.sched.relinquish(1);
    h.setTime(20_000); h.sched.run();            // evicts 10
    const evictedSoFar = h.evicted.length;
    h.sched.reacquire(1);
    h.setTime(40_000); h.sched.run();
    expect(h.evicted.length).toBe(evictedSoFar); // no further evictions
  });
});

describe("DrainScheduler: recompute deadline", () => {
  it("resets the deadline when a bucket is relinquished again", () => {
    const h = harness({ drainDelayMs: 20_000, evictionRatePerSec: 10 });
    h.addRooms(1, nRooms(1, 50));
    h.sched.relinquish(1);          // deadline 20000
    h.setTime(10_000); h.sched.relinquish(1); // deadline now 30000
    h.setTime(20_001); h.sched.run();
    expect(h.evicted).toEqual([]);  // old deadline no longer applies
    h.setTime(31_000); h.sched.run();
    expect(h.evicted.length).toBeGreaterThan(0);
  });
});
