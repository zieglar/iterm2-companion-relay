// Distributed-mode only: the proof origin (§6.10). The origin bound into the
// join/delete transcripts and the App Attest clientData is exactly
// "https://" + host, where host is the map/cert authority VERBATIM (no
// normalization), so client and relay derive byte-identical strings. This
// mirrors the client's ShardHostResolver ("https://" + host).
//
// STUB: not yet implemented (tests are written first, TDD red).

// originForHost(host) -> "https://" + host, taken verbatim (no lowercasing, no
// trailing-dot stripping, no port defaulting). host is an authority
// (name or bracketed IP, optional :port), never a scheme/path.
export function originForHost(host) {
  throw new Error("not implemented: originForHost");
}

// assertOriginMatches(configuredOrigin, host) -> void
// Boot-time invariant (Appendix A #7): the box's configured RELAY_ORIGIN must
// equal originForHost(host) byte-for-byte, or every signed proof for this box's
// buckets fails. Throws (with the two values in the message) on any mismatch.
export function assertOriginMatches(configuredOrigin, host) {
  throw new Error("not implemented: assertOriginMatches");
}
