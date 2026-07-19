// The §6.9 re-resolution wire codes: what the relay emits, and the shared
// classification of a close/status into how a client should react. The relay
// emits 421 (reject) and 4421 + a `reshard` reason (evict); the classifier is
// the canonical taxonomy both sides agree on (the Swift client re-implements the
// consuming half). See docs/companion-relay-design.md (§6.9).

// --- Emission (relay side) ---
export const HTTP_MISDIRECTED = 421;   // reject-to-re-resolve on admission / HTTP data plane
export const WS_RESHARD_CODE = 4421;   // evict-to-re-resolve on a live socket
export const RESHARD_SENTINEL = "reshard";

// reshardReason(owner?) -> the WS 4421 close reason (bare, or `reshard <owner>`).
export function reshardReason(owner) {
  return owner ? `${RESHARD_SENTINEL} ${owner}` : RESHARD_SENTINEL;
}

// parseReshardReason(reason) -> { isReshard, owner }. Whole-token sentinel only,
// so `reshardxyz` does NOT match.
export function parseReshardReason(reason) {
  if (typeof reason !== "string") return { isReshard: false, owner: null };
  if (reason === RESHARD_SENTINEL) return { isReshard: true, owner: null };
  const prefix = RESHARD_SENTINEL + " ";
  if (reason.startsWith(prefix)) return { isReshard: true, owner: reason.slice(prefix.length) };
  return { isReshard: false, owner: null };
}

// --- Classification (shared taxonomy) ---
export const Category = {
  RE_RESOLVE: "re-resolve",
  RETRY_HERE: "retry-here",
  LONG_BACKOFF: "long-backoff",
  FATAL: "fatal",
};

// classifyWsClose({ code, reason }) -> Category. 1008 and 1000 are
// reason-disambiguated: only `daily quota` / `displaced` are long-backoff.
export function classifyWsClose({ code, reason }) {
  const lower = (typeof reason === "string" ? reason : "").toLowerCase();
  if (code === WS_RESHARD_CODE || parseReshardReason(reason).isReshard) return Category.RE_RESOLVE;
  if (code === 1008 && lower.includes("daily quota")) return Category.LONG_BACKOFF;
  if (code === 1000 && lower.includes("displaced")) return Category.LONG_BACKOFF;
  return Category.RETRY_HERE;
}

// classifyHttpStatus(status) -> Category.
export function classifyHttpStatus(status) {
  if (status === HTTP_MISDIRECTED) return Category.RE_RESOLVE;
  if (status === 403 || status === 413) return Category.FATAL;
  return Category.RETRY_HERE; // 429 / 503 / 500 and a safe default
}
