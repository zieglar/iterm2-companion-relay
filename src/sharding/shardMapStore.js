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
// See docs/companion-relay-design.md (§6.5, §6.6, §6.8).

import { ownedBuckets, diffOwned } from "./ownedSet.js";

const EMPTY_DIFF = () => ({ adopted: false, acquired: new Set(), relinquished: new Set() });

export class ShardMapStore {
  constructor({ selfHost }) {
    this._selfHost = selfHost;
    this._map = null;
    this._owned = new Set();
  }

  get version() {
    return this._map ? this._map.version : -1;
  }

  get hasMap() {
    return this._map !== null;
  }

  // applyFetched(validatedMap) -> { adopted, acquired, relinquished }
  applyFetched(validatedMap) {
    if (this._map && validatedMap.version <= this._map.version) {
      return EMPTY_DIFF(); // monotonic: ignore equal-or-older
    }
    const newOwned = ownedBuckets(validatedMap, this._selfHost);
    const { acquired, relinquished } = diffOwned(this._owned, newOwned);
    this._map = validatedMap;
    this._owned = newOwned;
    return { adopted: true, acquired, relinquished };
  }

  // applyFetchError() -> void. Keep last-known-good; no state change.
  applyFetchError() {
    /* deliberately nothing: hold the current map */
  }

  ownsBucket(bucket) {
    return this._owned.has(bucket);
  }

  ownedBuckets() {
    return new Set(this._owned);
  }
}
