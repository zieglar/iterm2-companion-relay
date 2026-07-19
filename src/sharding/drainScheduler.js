// Distributed-mode only: the gradual-eviction / drain scheduler (§7.4). Closes
// the live splices of relinquished buckets, deferred then rate-limited, so a
// reshard does not fire a handshake storm at the new owners.
//
//   - Defer: after a bucket is relinquished, wait RESHARD_DRAIN_DELAY before any
//     eviction (covers poll-phase skew so the gaining host has already polled).
//   - Rate: evict at most RESHARD_EVICTION_RATE rooms/second, globally.
//   - Atomic per room: evict(roomId) closes both endpoints; each room once.
//   - Recompute: relinquishing an already-draining bucket resets its deadline.
//   - Cancel-on-re-acquire: a re-acquired bucket's live rooms never move.
//
// New joins for a relinquished bucket are rejected immediately by the ownership
// gate (admission.js), not here; this scheduler only drains EXISTING splices.
//
// Time is injected (`now()` returns ms) so tests use a virtual clock and never
// sleep. Token bucket: tokens accrue at `evictionRatePerSec` (capped at one
// second's worth) from construction, and are spent only on rooms of
// past-deadline buckets, so the drain starts with at most one second's burst and
// then paces at the rate.

export class DrainScheduler {
  constructor({ drainDelayMs, evictionRatePerSec, now, evict, liveRooms }) {
    this._drainDelayMs = drainDelayMs;
    this._rate = evictionRatePerSec;
    this._now = now;
    this._evict = evict;
    this._liveRooms = liveRooms;
    this._draining = new Map(); // bucket -> deadline ms
    this._evicted = new Set();  // room ids already evicted (never re-evict)
    this._tokens = 0;
    this._lastRunMs = now();
  }

  relinquish(bucket) {
    this._draining.set(bucket, this._now() + this._drainDelayMs);
  }

  reacquire(bucket) {
    this._draining.delete(bucket);
  }

  run() {
    const t = this._now();
    this._tokens = Math.min(this._rate, this._tokens + ((t - this._lastRunMs) * this._rate) / 1000);
    this._lastRunMs = t;

    const evicted = [];
    for (const [bucket, deadline] of this._draining) {
      if (deadline > t) continue; // still deferring this bucket
      for (const id of this._liveRooms(bucket)) {
        if (this._tokens < 1) break;
        if (this._evicted.has(id)) continue;
        this._tokens -= 1;
        this._evicted.add(id);
        this._evict(id);
        evicted.push(id);
      }
      if (this._tokens < 1) break; // global rate: stop scanning further buckets
    }
    return evicted;
  }

  get drainingBuckets() {
    return new Set(this._draining.keys());
  }
}
