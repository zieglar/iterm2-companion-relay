// Distributed-mode only: the parsed, validated shard map (bucket ranges -> host)
// and bucket -> host lookup. Mirrors Swift's ShardMap so both sides agree on
// what a well-formed map is. See docs/companion-relay-design.md (§6.2, §6.3).

// The immutable bucket count. Fixed forever (Appendix A invariant 1); the map
// does not carry it.
export const EXPECTED_BUCKETS = 65536;

// Validation failure kinds, matching Swift's ShardMap.ValidationError.
export const ShardMapError = {
  negativeVersion: "negativeVersion",
  emptyRanges: "emptyRanges",
  emptyHost: "emptyHost",
  invalidRange: "invalidRange",
  gapOrOverlap: "gapOrOverlap",
  malformed: "malformed",
};

// A thrown validation/parse error carries `.kind` (one of ShardMapError) so
// tests and callers can branch without string-matching a message.
export class ShardMapValidationError extends Error {
  constructor(kind, detail) {
    super(detail ? `${kind}: ${detail}` : kind);
    this.name = "ShardMapValidationError";
    this.kind = kind;
  }
}

const isInt = (x) => typeof x === "number" && Number.isInteger(x);

// parseShardMap(text) -> { version, ranges: [{low,high,host}] }. Throws
// ShardMapValidationError {kind: "malformed"} on bad JSON or wrong shape. Does
// NOT check the partition; call validateShardMap() for that.
export function parseShardMap(text) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new ShardMapValidationError(ShardMapError.malformed, "invalid JSON");
  }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    throw new ShardMapValidationError(ShardMapError.malformed, "not an object");
  }
  if (!isInt(obj.version)) {
    throw new ShardMapValidationError(ShardMapError.malformed, "version must be an integer");
  }
  if (!Array.isArray(obj.ranges)) {
    throw new ShardMapValidationError(ShardMapError.malformed, "ranges must be an array");
  }
  const ranges = obj.ranges.map((r) => {
    if (typeof r !== "object" || r === null || !isInt(r.low) || !isInt(r.high) || typeof r.host !== "string") {
      throw new ShardMapValidationError(ShardMapError.malformed, "bad range entry");
    }
    return { low: r.low, high: r.high, host: r.host };
  });
  return { version: obj.version, ranges };
}

// validateShardMap(map) -> void; throws ShardMapValidationError. Version >= 0,
// at least one range, every range in-bounds with a non-empty host, and the
// ranges exactly tiling [0, EXPECTED_BUCKETS - 1].
export function validateShardMap(map) {
  if (map.version < 0) throw new ShardMapValidationError(ShardMapError.negativeVersion);
  if (!Array.isArray(map.ranges) || map.ranges.length === 0) {
    throw new ShardMapValidationError(ShardMapError.emptyRanges);
  }
  for (const r of map.ranges) {
    if (r.host === "") throw new ShardMapValidationError(ShardMapError.emptyHost);
    if (r.low > r.high || r.low < 0 || r.high >= EXPECTED_BUCKETS) {
      throw new ShardMapValidationError(ShardMapError.invalidRange, `${r.low}..${r.high}`);
    }
  }
  // Sort by low and walk: must start at 0, each next exactly one past the
  // previous (a larger low is a gap, a smaller-or-equal one an overlap), and the
  // last must end at EXPECTED_BUCKETS - 1.
  const sorted = [...map.ranges].sort((a, b) => a.low - b.low);
  let expectedNext = 0;
  for (const r of sorted) {
    if (r.low !== expectedNext) throw new ShardMapValidationError(ShardMapError.gapOrOverlap);
    expectedNext = r.high + 1;
  }
  if (expectedNext !== EXPECTED_BUCKETS) throw new ShardMapValidationError(ShardMapError.gapOrOverlap);
}

// hostForBucket(map, bucket) -> host string, or null if out of range / uncovered.
export function hostForBucket(map, bucket) {
  if (bucket < 0 || bucket >= EXPECTED_BUCKETS) return null;
  for (const r of map.ranges) {
    if (bucket >= r.low && bucket <= r.high) return r.host;
  }
  return null;
}
