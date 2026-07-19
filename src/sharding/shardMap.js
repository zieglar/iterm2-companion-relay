// Distributed-mode only: the parsed, validated shard map (bucket ranges -> host)
// and bucket -> host lookup. Mirrors Swift's ShardMap so both sides agree on
// what a well-formed map is. See docs/companion-relay-design.md (§6.2, §6.3).
//
// STUB: not yet implemented (tests are written first, TDD red).

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

// parseShardMap(text: string) -> { version: number, ranges: [{low,high,host}] }
// Parses JSON and checks structural shape (numeric version, ranges array of
// {low:number, high:number, host:string}). Throws ShardMapValidationError
// {kind: "malformed"} on bad JSON or wrong shape. Does NOT check the partition;
// call validateShardMap() for that.
export function parseShardMap(text) {
  throw new Error("not implemented: parseShardMap");
}

// validateShardMap(map) -> void; throws ShardMapValidationError on:
//  - version < 0                          -> negativeVersion
//  - no ranges                            -> emptyRanges
//  - a range with an empty host           -> emptyHost
//  - low > high, or out of [0, N-1]       -> invalidRange
//  - ranges do not exactly tile [0, N-1]  -> gapOrOverlap
export function validateShardMap(map) {
  throw new Error("not implemented: validateShardMap");
}

// hostForBucket(map, bucket) -> host string, or null if out of range / uncovered.
export function hostForBucket(map, bucket) {
  throw new Error("not implemented: hostForBucket");
}
