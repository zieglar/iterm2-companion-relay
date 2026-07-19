// Distributed-mode only: which buckets a box owns, and the acquired/relinquished
// diff between two owned sets across a map reload. A box owns the buckets in
// every shard-map range whose `host` equals its provisioned self-identity; on a
// reload it diffs the new owned set against the old to derive what it just
// acquired (accept immediately) and relinquished (schedule drain).
// See docs/companion-relay-design.md (§6.5).

// ownedBuckets(map, selfHost) -> Set<number>
export function ownedBuckets(map, selfHost) {
  const owned = new Set();
  for (const r of map.ranges) {
    if (r.host !== selfHost) continue;
    for (let b = r.low; b <= r.high; b++) owned.add(b);
  }
  return owned;
}

// diffOwned(oldSet, newSet) -> { acquired: Set<number>, relinquished: Set<number> }
export function diffOwned(oldSet, newSet) {
  const acquired = new Set();
  const relinquished = new Set();
  for (const b of newSet) if (!oldSet.has(b)) acquired.add(b);
  for (const b of oldSet) if (!newSet.has(b)) relinquished.add(b);
  return { acquired, relinquished };
}
