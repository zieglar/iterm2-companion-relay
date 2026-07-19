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
// sleep. Token bucket: tokens accrue at `evictionRatePerSec`, capped at one
// second's worth, and are spent only on rooms of past-deadline buckets.
//
// STUB: not yet implemented (tests are written first, TDD red).

export class DrainScheduler {
  // { drainDelayMs, evictionRatePerSec, now, evict, liveRooms }
  //   now()            -> current time in ms
  //   evict(roomId)    -> close the room's two sockets (called once per room)
  //   liveRooms(bucket)-> array of live room ids currently in that bucket
  constructor({ drainDelayMs, evictionRatePerSec, now, evict, liveRooms }) {
    throw new Error("not implemented: DrainScheduler");
  }

  // Mark a bucket as relinquished; deadline = now() + drainDelayMs. Calling it
  // again for the same bucket recomputes the deadline from the latest call.
  relinquish(bucket) {
    throw new Error("not implemented: relinquish");
  }

  // Cancel draining for a bucket (it is ours again); its live rooms stay.
  reacquire(bucket) {
    throw new Error("not implemented: reacquire");
  }

  // Advance to now() and evict eligible rooms up to the rate. Returns the list of
  // room ids evicted on this call.
  run() {
    throw new Error("not implemented: run");
  }

  // The set of buckets currently draining (for introspection / tests).
  get drainingBuckets() {
    throw new Error("not implemented: drainingBuckets");
  }
}
