// Distributed-mode only: the in-memory shard-map state a relay holds, and the
// rules that keep it safe when stale. This is the §6.5/§6.6/§6.8 core, factored
// out of any networking so it can be unit-tested: the poller feeds it fetch
// results and it decides what to adopt and what changed.
//
//  - Monotonic: adopt a fetched map only if its version is strictly greater than
//    the one held; ignore equal-or-older (a lagging CDN edge).
//  - Last-known-good: a fetch error changes nothing; never fail-open/closed.
//  - Own-nothing is valid: a map that assigns this host zero buckets is adopted
//    (drain to empty), which is distinct from having no map yet.
//
// The store composes ownedBuckets()/diffOwned() and emits the acquired/
// relinquished diff on each adopt so the caller can start accepting / schedule
// drains. See docs/companion-relay-design.md (§6.5, §6.6, §6.8).
//
// STUB: not yet implemented (tests are written first, TDD red).

// eslint-disable-next-line no-unused-vars
import { ownedBuckets, diffOwned } from "./ownedSet.js";

export class ShardMapStore {
  // constructor({ selfHost }): selfHost is this box's provisioned identity, the
  // `host` string it matches in the map.
  constructor({ selfHost }) {
    throw new Error("not implemented: ShardMapStore");
  }

  // The adopted map's version, or -1 when no map has been adopted yet.
  get version() {
    throw new Error("not implemented: version");
  }

  // True once any map has been adopted (distinguishes own-nothing from no-map).
  get hasMap() {
    throw new Error("not implemented: hasMap");
  }

  // applyFetched(validatedMap) -> { adopted: boolean, acquired: Set, relinquished: Set }
  // Adopt iff version strictly increases. On a non-adopt, acquired/relinquished
  // are empty and state is unchanged.
  applyFetched(validatedMap) {
    throw new Error("not implemented: applyFetched");
  }

  // applyFetchError() -> void. Keep last-known-good; no state change.
  applyFetchError() {
    throw new Error("not implemented: applyFetchError");
  }

  // ownsBucket(bucket) -> boolean, against the currently adopted map.
  ownsBucket(bucket) {
    throw new Error("not implemented: ownsBucket");
  }

  // ownedBuckets() -> Set<number>, a copy of the current owned set.
  ownedBuckets() {
    throw new Error("not implemented: ownedBuckets");
  }
}
