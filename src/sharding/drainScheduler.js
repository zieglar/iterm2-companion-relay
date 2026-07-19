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
    // bucket -> { deadline, evicted: Set }. The evicted set is scoped to THIS
    // drain episode (idempotency within the episode when liveRooms lingers), not
    // the process: a fresh relinquish starts a fresh episode, and reacquire drops
    // it, so a bucket that ping-pongs back and is relinquished again drains its
    // re-formed rooms instead of being stranded, and nothing leaks past a drain.
    this._draining = new Map();
    this._tokens = 0;
    this._lastRunMs = now();
  }

  relinquish(bucket) {
    // A new episode: fresh deadline and a fresh evicted set (so a re-relinquished
    // bucket re-evicts, and a recomputed deadline restarts cleanly).
    this._draining.set(bucket, { deadline: this._now() + this._drainDelayMs, evicted: new Set() });
  }

  reacquire(bucket) {
    this._draining.delete(bucket); // drops the episode and its evicted set
  }

  run() {
    const t = this._now();
    this._tokens = Math.min(this._rate, this._tokens + ((t - this._lastRunMs) * this._rate) / 1000);
    this._lastRunMs = t;

    const evicted = [];
    for (const [bucket, ep] of this._draining) {
      if (ep.deadline > t) continue; // still deferring this bucket
      for (const id of this._liveRooms(bucket)) {
        if (this._tokens < 1) break;
        if (ep.evicted.has(id)) continue; // already evicted in THIS episode
        this._tokens -= 1;
        ep.evicted.add(id);
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

  // Number of buckets currently draining (cheap; for metrics).
  get drainingCount() {
    return this._draining.size;
  }
}
