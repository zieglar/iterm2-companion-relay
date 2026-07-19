// Distributed-mode only: derive a pairing's shard bucket from its room name.
//
// This MUST stay byte-for-byte identical to Swift's RelayRoom (see the Companion
// RoomBucketVectors cross-language vector, mirrored in
// test/fixtures/roomBucketVectors.json) or rendezvous silently breaks. See
// docs/companion-relay-design.md (§6.2, Appendix A invariant 1).
//
//   roomName = SHA256(canonicalEncode("iterm2-room", [rs, utf8(pid)])), lowercase hex
//   bucket   = digest[30] << 8 | digest[31]   (big-endian last two bytes; 0..65535)
//
// The relay normally receives the room name in the x-relay-room header and needs
// only bucketForRoomName(); roomName()/bucketFor() exist to pin the derivation
// against the shared vector.

import { canonicalEncode } from "../room.js";
import { createHash } from "node:crypto";

export const N_BUCKETS = 65536;

// A canonical room name is exactly 64 lowercase-ASCII hex characters (the form
// roomName() emits). Not Unicode Hex_Digit: uppercase and fullwidth forms are
// not canonical and correspond to no digest.
const CANONICAL_ROOM_NAME = /^[0-9a-f]{64}$/;

// roomName(rs: Uint8Array, pid: string) -> 64-char lowercase hex string.
export function roomName(rs, pid) {
  const preimage = canonicalEncode("iterm2-room", [rs, new TextEncoder().encode(pid)]);
  return createHash("sha256").update(preimage).digest("hex");
}

// bucketForRoomName(name: string) -> integer in [0, N_BUCKETS) or null.
// The bucket is the numeric value of the last four hex chars, i.e. digest bytes
// 30 and 31 big-endian.
export function bucketForRoomName(name) {
  if (typeof name !== "string" || !CANONICAL_ROOM_NAME.test(name)) return null;
  return parseInt(name.slice(60), 16);
}

// bucketFor(rs: Uint8Array, pid: string) -> integer in [0, N_BUCKETS).
export function bucketFor(rs, pid) {
  return bucketForRoomName(roomName(rs, pid));
}
