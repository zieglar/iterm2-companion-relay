// The §6.9 re-resolution wire codes: what the relay emits, and the shared
// classification of a close/status into how a client should react. The relay
// emits 421 (reject) and 4421 + a `reshard` reason (evict); the classifier is
// the canonical taxonomy both sides agree on (the Swift client re-implements the
// consuming half). See docs/companion-relay-design.md (§6.9).
//
// STUB: not yet implemented (tests are written first, TDD red).

// --- Emission (relay side) ---
export const HTTP_MISDIRECTED = 421;   // reject-to-re-resolve on admission / HTTP data plane
export const WS_RESHARD_CODE = 4421;   // evict-to-re-resolve on a live socket
export const RESHARD_SENTINEL = "reshard";

// reshardReason(owner?) -> the WS 4421 close reason. Bare `reshard`, or
// `reshard <owner>` when a diagnostic owner hint is included (§6.9).
export function reshardReason(owner) {
  throw new Error("not implemented: reshardReason");
}

// parseReshardReason(reason) -> { isReshard: boolean, owner: string | null }
// isReshard iff the reason is exactly `reshard` or begins with `reshard ` (a
// whole-token sentinel, so `reshardxyz` does NOT match). owner is the text after
// the single space, or null.
export function parseReshardReason(reason) {
  throw new Error("not implemented: parseReshardReason");
}

// --- Classification (shared taxonomy) ---
export const Category = {
  RE_RESOLVE: "re-resolve",     // leave this host: refetch the map, go to the new owner
  RETRY_HERE: "retry-here",     // same host, short jittered backoff
  LONG_BACKOFF: "long-backoff", // same host, deliberately long delay
  FATAL: "fatal",               // do not blind-retry
};

// classifyWsClose({ code, reason }) -> Category
//   4421, or reason begins `reshard`                 -> RE_RESOLVE
//   1008 + reason ~ "daily quota"                    -> LONG_BACKOFF
//   1000 + reason ~ "displaced"                      -> LONG_BACKOFF
//   1011, 1006, 1001, or other 1008/1000             -> RETRY_HERE
export function classifyWsClose({ code, reason }) {
  throw new Error("not implemented: classifyWsClose");
}

// classifyHttpStatus(status) -> Category
//   421            -> RE_RESOLVE
//   429, 503, 500  -> RETRY_HERE
//   403, 413       -> FATAL
//   otherwise      -> RETRY_HERE (safe default)
export function classifyHttpStatus(status) {
  throw new Error("not implemented: classifyHttpStatus");
}
