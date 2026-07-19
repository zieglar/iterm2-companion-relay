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

import { bucketForRoomName } from "./bucket.js";
import { MODE_DIRECT } from "./mode.js";

export const REJECT_STATUS = 421;

// ownershipDecision({ mode, roomName, ownsBucket }) -> decision
//   direct mode -> { admit: true } (owns every bucket; never rejects)
//   distributed -> derive the bucket, then admit iff ownsBucket(bucket).
export function ownershipDecision({ mode, roomName, ownsBucket }) {
  if (mode === MODE_DIRECT) return { admit: true };

  const bucket = bucketForRoomName(roomName);
  if (bucket === null) {
    return { admit: false, status: REJECT_STATUS, reason: "unroutable", bucket: null };
  }
  if (ownsBucket(bucket)) return { admit: true, bucket };
  return { admit: false, status: REJECT_STATUS, reason: "not-owner", bucket };
}
