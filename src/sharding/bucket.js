// The roomName -> bucket extraction, kept dependency-free (no canonicalEncode /
// crypto / runtime import) so host/runtime.js can import it without the import
// cycle that pulling in the full room.js derivation would create. See
// docs/companion-relay-design.md (§6.2, Appendix A invariant 1).

export const N_BUCKETS = 65536;

// A canonical room name is exactly 64 lowercase-ASCII hex characters (the form
// roomName() emits). Not Unicode Hex_Digit: uppercase and fullwidth forms are
// not canonical and correspond to no digest.
const CANONICAL_ROOM_NAME = /^[0-9a-f]{64}$/;

// bucketForRoomName(name) -> integer in [0, N_BUCKETS) or null. The bucket is
// the numeric value of the last four hex chars (digest bytes 30,31 big-endian).
export function bucketForRoomName(name) {
  if (typeof name !== "string" || !CANONICAL_ROOM_NAME.test(name)) return null;
  return parseInt(name.slice(60), 16);
}
