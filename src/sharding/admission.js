// Distributed-mode only: the data-plane ownership gate (reject-on-doubt, §6.5,
// Appendix A invariant 2). A single transport-agnostic decision the host applies
// to BOTH a WebSocket upgrade and the room-scoped HTTP endpoints
// (/attest/challenge, /attest, /register, /delete): admit only if this box owns
// the room's bucket, else reject with HTTP 421 so the client re-resolves.
//
// The server MUST call this early, before reading the body, running App Attest,
// or charging the /attest rate limiter, so a stale-map bounce is neither an
// attest failure nor a limiter drain (that ordering is a server-integration
// concern, marked it.todo in the test).
//
// STUB: not yet implemented (tests are written first, TDD red).

// eslint-disable-next-line no-unused-vars
import { bucketForRoomName } from "./room.js";
import { MODE_DIRECT, MODE_DISTRIBUTED } from "./mode.js";

export const REJECT_STATUS = 421;

// ownershipDecision({ mode, roomName, ownsBucket }) -> decision
//   direct mode  -> { admit: true }  (owns every bucket; never rejects)
//   distributed  -> derive bucket from roomName, then:
//     - roomName not bucketable      -> { admit: false, status: 421, reason: "unroutable", bucket: null }
//     - ownsBucket(bucket) is false  -> { admit: false, status: 421, reason: "not-owner", bucket }
//     - ownsBucket(bucket) is true   -> { admit: true, bucket }
// `ownsBucket` is a (bucket:number)->boolean predicate (e.g. ShardMapStore.ownsBucket).
export function ownershipDecision({ mode, roomName, ownsBucket }) {
  throw new Error("not implemented: ownershipDecision");
}
