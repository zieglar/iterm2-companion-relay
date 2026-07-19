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
// bucketForRoomName lives in ./bucket.js (dependency-free, so host/runtime.js can
// import it without a cycle); it is re-exported here for callers that want the
// whole derivation. The relay normally receives the room name in the
// x-relay-room header and needs only bucketForRoomName(); roomName()/bucketFor()
// exist to pin the derivation against the shared vector.

import { canonicalEncode } from "../room.js";
import { createHash } from "node:crypto";
import { N_BUCKETS, bucketForRoomName } from "./bucket.js";

export { N_BUCKETS, bucketForRoomName };

// roomName(rs: Uint8Array, pid: string) -> 64-char lowercase hex string.
export function roomName(rs, pid) {
  const preimage = canonicalEncode("iterm2-room", [rs, new TextEncoder().encode(pid)]);
  return createHash("sha256").update(preimage).digest("hex");
}

// bucketFor(rs: Uint8Array, pid: string) -> integer in [0, N_BUCKETS).
export function bucketFor(rs, pid) {
  return bucketForRoomName(roomName(rs, pid));
}
