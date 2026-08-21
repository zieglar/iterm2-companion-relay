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
// second's worth, but never below one whole token, or a sub-1 rate could never
// evict anything) from construction, and are spent only on rooms of
// past-deadline buckets, so the drain starts with at most one second's burst
// (at least one room) and then paces at the rate.

export class DrainScheduler {
  constructor({ drainDelayMs, evictionRatePerSec, now, evict, liveRooms }) {
    this._drainDelayMs = drainDelayMs;
    this._rate = evictionRatePerSec;
    // The burst cap. A fractional rate (say 0.5 rooms/second) must still reach
    // a whole token or run() would skip every room forever; capping at >= 1
    // preserves the pacing (one room per 1/rate seconds) with a one-room burst.
    this._cap = Math.max(1, evictionRatePerSec);
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
    this._tokens = Math.min(this._cap, this._tokens + ((t - this._lastRunMs) * this._rate) / 1000);
    this._lastRunMs = t;

    const evicted = [];
    for (const [bucket, ep] of this._draining) {
      if (ep.deadline > t) continue; // still deferring this bucket
      // A room left un-evicted for lack of tokens keeps the episode alive; a
      // pass that evicts (or has already evicted) every live room completes it.
      let starved = false;
      for (const id of this._liveRooms(bucket)) {
        if (ep.evicted.has(id)) continue; // already evicted in THIS episode
        if (this._tokens < 1) { starved = true; break; }
        this._tokens -= 1;
        ep.evicted.add(id);
        this._evict(id);
        evicted.push(id);
      }
      // Episode complete: every live room of this bucket has been evicted (or
      // there were none). Drop it so the draining gauge returns to 0 and later
      // ticks stop rescanning a dead bucket; a fresh relinquish starts a fresh
      // episode. (Deleting the current entry during Map iteration is safe.)
      if (!starved) this._draining.delete(bucket);
      if (starved) break; // global rate: stop scanning further buckets
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
