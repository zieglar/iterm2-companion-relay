// Distributed-mode only: which buckets a box owns, and the acquired/relinquished
// diff between two owned sets across a map reload. A box owns the buckets in
// every shard-map range whose `host` equals its provisioned self-identity; on a
// reload it diffs the new owned set against the old to derive what it just
// acquired (accept immediately) and relinquished (schedule drain).
// See docs/companion-relay-design.md (§6.5).
//
// STUB: not yet implemented (tests are written first, TDD red).

// ownedBuckets(map, selfHost) -> Set<number>
// The union of [low, high] for every range whose host === selfHost. Empty set if
// the host owns nothing (a valid "drain to empty" assignment) or is absent.
export function ownedBuckets(map, selfHost) {
  throw new Error("not implemented: ownedBuckets");
}

// diffOwned(oldSet, newSet) -> { acquired: Set<number>, relinquished: Set<number> }
// acquired = newSet \ oldSet (start accepting); relinquished = oldSet \ newSet
// (schedule drain). Both empty when the sets are equal.
export function diffOwned(oldSet, newSet) {
  throw new Error("not implemented: diffOwned");
}
