// Decoding, validation (exact partition of the bucket space), and bucket -> host
// lookup for the shard map. Mirrors Swift's ShardMapTests so both sides agree on
// what a well-formed map is. See docs/companion-relay-design.md (§6.3).

import { describe, it, expect } from "vitest";
import {
  parseShardMap,
  validateShardMap,
  hostForBucket,
  EXPECTED_BUCKETS,
  ShardMapError,
} from "../../src/sharding/shardMap.js";

const N = EXPECTED_BUCKETS; // 65536
const map = (version, ranges) => ({ version, ranges });
const r = (low, high, host) => ({ low, high, host });

// Expect validateShardMap(m) to throw with a specific .kind.
const expectKind = (m, kind) => {
  let thrown;
  try { validateShardMap(m); } catch (e) { thrown = e; }
  expect(thrown, "expected validateShardMap to throw").toBeDefined();
  expect(thrown.kind).toBe(kind);
};

describe("parseShardMap", () => {
  it("decodes the canonical example", () => {
    const m = parseShardMap(JSON.stringify({
      version: 37,
      ranges: [
        { low: 0, high: 32767, host: "relay1.iterm2.com" },
        { low: 32768, high: 65535, host: "relay2.iterm2.com" },
      ],
    }));
    expect(m.version).toBe(37);
    expect(m.ranges).toEqual([
      { low: 0, high: 32767, host: "relay1.iterm2.com" },
      { low: 32768, high: 65535, host: "relay2.iterm2.com" },
    ]);
  });

  it("rejects malformed JSON and wrong shapes with kind=malformed", () => {
    for (const bad of ["{not json", "{}", JSON.stringify({ version: 1 }),
                       JSON.stringify({ version: "x", ranges: [] }),
                       JSON.stringify({ version: 1, ranges: [{ low: 0, high: "1", host: "h" }] })]) {
      let thrown;
      try { parseShardMap(bad); } catch (e) { thrown = e; }
      expect(thrown, `expected throw for ${bad}`).toBeDefined();
      expect(thrown.kind).toBe(ShardMapError.malformed);
    }
  });
});

describe("validateShardMap: valid shapes", () => {
  it("accepts a single host owning the whole ring", () => {
    expect(() => validateShardMap(map(1, [r(0, N - 1, "relay1.iterm2.com")]))).not.toThrow();
  });

  it("accepts a wrap arc written as two ranges sharing a host", () => {
    expect(() => validateShardMap(map(5, [
      r(0, 5000, "relay1.iterm2.com"),
      r(5001, 59999, "relay2.iterm2.com"),
      r(60000, N - 1, "relay1.iterm2.com"),
    ]))).not.toThrow();
  });

  it("accepts ranges given out of order", () => {
    expect(() => validateShardMap(map(2, [
      r(32768, N - 1, "relay2.iterm2.com"),
      r(0, 32767, "relay1.iterm2.com"),
    ]))).not.toThrow();
  });

  it("accepts version 0", () => {
    expect(() => validateShardMap(map(0, [r(0, N - 1, "relay1.iterm2.com")]))).not.toThrow();
  });
});

describe("validateShardMap: rejected shapes", () => {
  it("rejects a gap", () => {
    expectKind(map(1, [r(0, 100, "a"), r(102, N - 1, "b")]), ShardMapError.gapOrOverlap);
  });
  it("rejects an overlap", () => {
    expectKind(map(1, [r(0, 200, "a"), r(200, N - 1, "b")]), ShardMapError.gapOrOverlap);
  });
  it("rejects an uncovered tail", () => {
    expectKind(map(1, [r(0, N - 2, "a")]), ShardMapError.gapOrOverlap);
  });
  it("rejects a non-zero start", () => {
    expectKind(map(1, [r(1, N - 1, "a")]), ShardMapError.gapOrOverlap);
  });
  it("rejects empty ranges", () => {
    expectKind(map(1, []), ShardMapError.emptyRanges);
  });
  it("rejects an empty host", () => {
    expectKind(map(1, [r(0, N - 1, "")]), ShardMapError.emptyHost);
  });
  it("rejects low > high", () => {
    expectKind(map(1, [r(100, 50, "a"), r(0, N - 1, "b")]), ShardMapError.invalidRange);
  });
  it("rejects high out of bounds", () => {
    expectKind(map(1, [r(0, N, "a")]), ShardMapError.invalidRange);
  });
  it("rejects a negative version", () => {
    expectKind(map(-1, [r(0, N - 1, "a")]), ShardMapError.negativeVersion);
  });
});

describe("validateShardMap: host must be a bare authority (§6.3/§6.10)", () => {
  const withHost = (host) => map(1, [r(0, N - 1, host)]);

  it("accepts a DNS name, IPv4, bracketed IPv6, and an explicit port", () => {
    for (const h of ["relay1.iterm2.com", "relay1", "203.0.113.7",
                     "relay1.iterm2.com:8443", "[2001:db8::1]:8443"]) {
      expect(() => validateShardMap(withHost(h)), h).not.toThrow();
    }
  });

  it("rejects a scheme, path, userinfo, query, fragment, or whitespace", () => {
    for (const h of ["https://relay1", "relay1/x", "user@relay1", "relay1?x", "relay1#x", "relay1 x"]) {
      expectKind(withHost(h), ShardMapError.invalidHost);
    }
  });

  it("rejects uppercase and a trailing dot (must match cert SAN / proof origin verbatim)", () => {
    expectKind(withHost("Relay1.iterm2.com"), ShardMapError.invalidHost);
    expectKind(withHost("relay1.iterm2.com."), ShardMapError.invalidHost);
  });
});

describe("hostForBucket", () => {
  const m = map(1, [r(0, 32767, "relay1.iterm2.com"), r(32768, N - 1, "relay2.iterm2.com")]);
  it("returns the owning host at range boundaries", () => {
    expect(hostForBucket(m, 0)).toBe("relay1.iterm2.com");
    expect(hostForBucket(m, 32767)).toBe("relay1.iterm2.com");
    expect(hostForBucket(m, 32768)).toBe("relay2.iterm2.com");
    expect(hostForBucket(m, N - 1)).toBe("relay2.iterm2.com");
  });
  it("returns null for out-of-range buckets", () => {
    expect(hostForBucket(m, -1)).toBeNull();
    expect(hostForBucket(m, N)).toBeNull();
  });
  it("resolves a wrap arc's two ranges to the same host", () => {
    const w = map(1, [r(0, 5000, "relay1"), r(5001, 59999, "relay2"), r(60000, N - 1, "relay1")]);
    expect(hostForBucket(w, 0)).toBe("relay1");
    expect(hostForBucket(w, 65535)).toBe("relay1");
    expect(hostForBucket(w, 30000)).toBe("relay2");
  });
});
