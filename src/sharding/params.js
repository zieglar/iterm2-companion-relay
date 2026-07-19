// Distributed-mode tunables and the orderings the §6-§7 correctness arguments
// depend on. The numbers are operator-tunable; the relationships between them are
// not. See docs/companion-relay-design.md Appendix C.
//
// Defaults are real values (a spec lock); validateParams is the stub under test.

// CDN Cache-Control max-age on shardmap.json (a publish setting, not relay code).
export const SHARDMAP_TTL_MS = 5_000;
// How often a relay re-fetches shardmap.json.
export const SHARDMAP_POLL_INTERVAL_MS = 10_000;
// How long a relinquishing host waits before it starts evicting (>= 2x poll).
export const RESHARD_DRAIN_DELAY_MS = 20_000;
// Rooms/second a relinquishing host closes.
export const RESHARD_EVICTION_RATE = 10;

// Client reconnect backoff (client-side, documented here for one source of truth).
export const RECONNECT_JITTER_INITIAL_MS = 3_000;
export const RECONNECT_BACKOFF_BASE_MS = 1_000;
export const RECONNECT_BACKOFF_CAP_MS = 30_000;

// validateParams({ ttlMs, pollMs, drainDelayMs, evictionRate }) -> void
// Throws if an operator override breaks an invariant:
//   - ttlMs < pollMs                (a poll usually revalidates fresh)
//   - drainDelayMs >= 2 * pollMs     (covers worst-case poll-phase skew)
//   - evictionRate > 0
// The thrown error carries `.kind` in {"ttlNotBelowPoll","drainDelayTooShort","nonPositiveRate"}.
export function validateParams({ ttlMs, pollMs, drainDelayMs, evictionRate }) {
  throw new Error("not implemented: validateParams");
}
