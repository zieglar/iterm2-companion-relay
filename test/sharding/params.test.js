// Tunable defaults (Appendix C) and the orderings the correctness arguments
// depend on. See docs/companion-relay-design.md Appendix C, §7.4.

import { describe, it, expect } from "vitest";
import {
  SHARDMAP_TTL_MS, SHARDMAP_POLL_INTERVAL_MS, RESHARD_DRAIN_DELAY_MS, RESHARD_EVICTION_RATE,
  RECONNECT_JITTER_INITIAL_MS, RECONNECT_BACKOFF_BASE_MS, RECONNECT_BACKOFF_CAP_MS,
  validateParams,
} from "../../src/sharding/params.js";

describe("default values (Appendix C)", () => {
  it("matches the documented defaults", () => {
    expect(SHARDMAP_TTL_MS).toBe(5_000);
    expect(SHARDMAP_POLL_INTERVAL_MS).toBe(10_000);
    expect(RESHARD_DRAIN_DELAY_MS).toBe(20_000);
    expect(RESHARD_EVICTION_RATE).toBe(10);
    expect(RECONNECT_JITTER_INITIAL_MS).toBe(3_000);
    expect(RECONNECT_BACKOFF_BASE_MS).toBe(1_000);
    expect(RECONNECT_BACKOFF_CAP_MS).toBe(30_000);
  });

  it("satisfies the invariants at the defaults", () => {
    expect(SHARDMAP_TTL_MS).toBeLessThan(SHARDMAP_POLL_INTERVAL_MS);
    expect(RESHARD_DRAIN_DELAY_MS).toBeGreaterThanOrEqual(2 * SHARDMAP_POLL_INTERVAL_MS);
  });
});

describe("validateParams", () => {
  const good = { ttlMs: 5_000, pollMs: 10_000, drainDelayMs: 20_000, evictionRate: 10 };

  it("accepts the defaults", () => {
    expect(() => validateParams(good)).not.toThrow();
  });

  const expectKind = (params, kind) => {
    let thrown;
    try { validateParams(params); } catch (e) { thrown = e; }
    expect(thrown, "expected validateParams to throw").toBeDefined();
    expect(thrown.kind).toBe(kind);
  };

  it("rejects TTL >= poll interval", () => {
    expectKind({ ...good, ttlMs: 10_000 }, "ttlNotBelowPoll");
    expectKind({ ...good, ttlMs: 12_000 }, "ttlNotBelowPoll");
  });

  it("rejects a drain delay under 2x the poll interval", () => {
    expectKind({ ...good, drainDelayMs: 19_999 }, "drainDelayTooShort");
    expectKind({ ...good, drainDelayMs: 10_000 }, "drainDelayTooShort");
  });

  it("rejects a non-positive eviction rate", () => {
    expectKind({ ...good, evictionRate: 0 }, "nonPositiveRate");
    expectKind({ ...good, evictionRate: -1 }, "nonPositiveRate");
  });

  it("accepts a valid non-default retune", () => {
    expect(() => validateParams({ ttlMs: 2_000, pollMs: 5_000, drainDelayMs: 10_000, evictionRate: 25 }))
      .not.toThrow();
  });
});
