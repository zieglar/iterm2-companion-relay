// The data-plane ownership gate (reject-on-doubt). Same decision for a WS upgrade
// and the room-scoped HTTP endpoints. See docs/companion-relay-design.md (§6.5).

import { describe, it, expect } from "vitest";
import { ownershipDecision, REJECT_STATUS } from "../../src/sharding/admission.js";
import { MODE_DIRECT, MODE_DISTRIBUTED } from "../../src/sharding/mode.js";

// A valid room name from the shared vectors, whose bucket is 57888.
const ROOM = "611c035897cf71eebc08e531616a3470f666cd001532e1bd4957dd762efae220";
const ROOM_BUCKET = 57888;

describe("ownershipDecision: direct mode", () => {
  it("admits unconditionally and never parses a bucket", () => {
    // Even a garbage room name is admitted in direct mode (owns everything).
    expect(ownershipDecision({ mode: MODE_DIRECT, roomName: "not-a-room",
      ownsBucket: () => false }).admit).toBe(true);
    expect(ownershipDecision({ mode: MODE_DIRECT, roomName: ROOM,
      ownsBucket: () => false }).admit).toBe(true);
  });
});

describe("ownershipDecision: distributed mode", () => {
  it("admits when the box owns the bucket", () => {
    const d = ownershipDecision({ mode: MODE_DISTRIBUTED, roomName: ROOM,
      ownsBucket: (b) => b === ROOM_BUCKET });
    expect(d.admit).toBe(true);
    expect(d.bucket).toBe(ROOM_BUCKET);
  });

  it("rejects 421 when the box does not own the bucket", () => {
    const d = ownershipDecision({ mode: MODE_DISTRIBUTED, roomName: ROOM,
      ownsBucket: () => false });
    expect(d.admit).toBe(false);
    expect(d.status).toBe(REJECT_STATUS);
    expect(d.status).toBe(421);
    expect(d.bucket).toBe(ROOM_BUCKET);
    expect(d.reason).toBe("not-owner");
  });

  it("rejects 421 when the room name is not bucketable", () => {
    const d = ownershipDecision({ mode: MODE_DISTRIBUTED, roomName: "bad",
      ownsBucket: () => true });
    expect(d.admit).toBe(false);
    expect(d.status).toBe(421);
    expect(d.reason).toBe("unroutable");
    expect(d.bucket).toBeNull();
  });

  it("passes the derived bucket to ownsBucket (not a hardcoded value)", () => {
    const seen = [];
    ownershipDecision({ mode: MODE_DISTRIBUTED, roomName: ROOM,
      ownsBucket: (b) => { seen.push(b); return true; } });
    expect(seen).toEqual([ROOM_BUCKET]);
  });
});

// The server-integration ordering guarantees (reject BEFORE the 101 / the attest
// limiter / the body read) are exercised end-to-end against a booted host in
// test/host/shardGate.test.js.
