// roomName -> shard bucket derivation. The cross-language vectors here are copied
// verbatim from Companion RoomBucketVectors.swift (test/fixtures/roomBucketVectors.json);
// a drift on either side fails loudly. Mirrors the Swift RoomBucketTests.
// See docs/companion-relay-design.md (§6.2, Appendix A invariant 1).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { roomName, bucketForRoomName, bucketFor, N_BUCKETS } from "../../src/sharding/room.js";

const vectorsPath = fileURLToPath(new URL("../fixtures/roomBucketVectors.json", import.meta.url));
const vectorFile = JSON.parse(readFileSync(vectorsPath, "utf8"));

const hexToBytes = (hex) => {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
};

describe("bucket: cross-language vectors", () => {
  it("uses the shared N_BUCKETS", () => {
    expect(N_BUCKETS).toBe(65536);
    expect(vectorFile.n_buckets).toBe(N_BUCKETS);
  });

  it("reproduces every room_name and bucket byte-for-byte", () => {
    expect(vectorFile.vectors.length).toBeGreaterThan(0);
    for (const v of vectorFile.vectors) {
      const rs = hexToBytes(v.rs_hex);
      expect(roomName(rs, v.pid)).toBe(v.room_name);
      expect(bucketForRoomName(v.room_name)).toBe(v.bucket);
      expect(bucketFor(rs, v.pid)).toBe(v.bucket);
      expect(v.bucket).toBeGreaterThanOrEqual(0);
      expect(v.bucket).toBeLessThan(N_BUCKETS);
    }
  });
});

describe("bucket: the two derivations agree", () => {
  it("bucketFor(rs,pid) matches bucketForRoomName(name(rs,pid))", () => {
    const rs = new Uint8Array(32).fill(0x5a);
    const pid = "consistency";
    expect(bucketFor(rs, pid)).toBe(bucketForRoomName(roomName(rs, pid)));
  });
});

describe("bucketForRoomName: byte order and bounds", () => {
  it("reads the last two bytes big-endian", () => {
    // "...0102" is 0x0102 = 258, NOT 0x0201; catches an endianness flip.
    const name = "0".repeat(60) + "0102";
    expect(bucketForRoomName(name)).toBe(0x0102);
    expect(bucketForRoomName(name)).toBe(258);
  });

  it("has no sign error on a high bit", () => {
    // 0xff00 = 65280; a signed-byte bug would misread the high bit.
    expect(bucketForRoomName("0".repeat(60) + "ff00")).toBe(0xff00);
  });

  it("spans the full range at the extremes", () => {
    expect(bucketForRoomName("0".repeat(64))).toBe(0);
    expect(bucketForRoomName("f".repeat(64))).toBe(N_BUCKETS - 1);
  });
});

describe("bucketForRoomName: rejects non-canonical input", () => {
  it("rejects uppercase hex (canonical room names are lowercase)", () => {
    expect(bucketForRoomName("0".repeat(60) + "ABCD")).toBeNull();
  });

  it("rejects fullwidth digits that are not ASCII hex", () => {
    const fullwidthZero = "０";
    const name = fullwidthZero.repeat(60) + "abcd";
    expect(name.length).toBe(64);
    expect(bucketForRoomName(name)).toBeNull();
  });

  it("rejects the wrong length", () => {
    expect(bucketForRoomName("abcd")).toBeNull();
    expect(bucketForRoomName("a".repeat(63))).toBeNull();
    expect(bucketForRoomName("a".repeat(65))).toBeNull();
    expect(bucketForRoomName("")).toBeNull();
  });

  it("rejects non-hex characters", () => {
    expect(bucketForRoomName("g".repeat(64))).toBeNull();
  });

  it("rejects non-string input", () => {
    expect(bucketForRoomName(null)).toBeNull();
    expect(bucketForRoomName(undefined)).toBeNull();
    expect(bucketForRoomName(12345)).toBeNull();
  });
});
