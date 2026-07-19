// Distributed-mode only: the proof origin (§6.10). The origin bound into the
// join/delete transcripts and the App Attest clientData is exactly
// "https://" + host, where host is the map/cert authority VERBATIM (no
// normalization), so client and relay derive byte-identical strings. This
// mirrors the client's ShardHostResolver ("https://" + host).

// originForHost(host) -> "https://" + host, taken verbatim.
export function originForHost(host) {
  return "https://" + host;
}

// assertOriginMatches(configuredOrigin, host) -> void. Boot-time invariant
// (Appendix A #7): the configured RELAY_ORIGIN must equal originForHost(host)
// byte-for-byte, or every signed proof for this box's buckets fails.
export function assertOriginMatches(configuredOrigin, host) {
  const expected = originForHost(host);
  if (configuredOrigin !== expected) {
    throw new Error(
      `relay origin mismatch: configured "${configuredOrigin}" != "${expected}" ` +
      `(derived from map host "${host}"); every signed proof would fail`);
  }
}
