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
//
// STUB: not yet implemented (tests are written first, TDD red).

// eslint-disable-next-line no-unused-vars
import { canonicalEncode } from "../room.js";
// eslint-disable-next-line no-unused-vars
import { createHash } from "node:crypto";

export const N_BUCKETS = 65536;

// roomName(rs: Uint8Array, pid: string) -> 64-char lowercase hex string.
export function roomName(rs, pid) {
  throw new Error("not implemented: roomName");
}

// bucketForRoomName(name: string) -> integer in [0, N_BUCKETS) or null.
// null unless `name` is exactly 64 lowercase-ASCII hex chars (the canonical form
// roomName() emits): the bucket is the numeric value of the last four hex chars,
// i.e. digest bytes 30 and 31 big-endian.
export function bucketForRoomName(name) {
  throw new Error("not implemented: bucketForRoomName");
}

// bucketFor(rs: Uint8Array, pid: string) -> integer in [0, N_BUCKETS).
export function bucketFor(rs, pid) {
  throw new Error("not implemented: bucketFor");
}
