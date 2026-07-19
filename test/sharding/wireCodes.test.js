// The §6.9 re-resolution wire codes and the retry-here / long-backoff /
// re-resolve / fatal classification. See docs/companion-relay-design.md (§6.9).

import { describe, it, expect } from "vitest";
import {
  HTTP_MISDIRECTED, WS_RESHARD_CODE, RESHARD_SENTINEL,
  reshardReason, parseReshardReason,
  classifyWsClose, classifyHttpStatus, Category,
} from "../../src/sharding/wireCodes.js";

describe("wire code constants", () => {
  it("pins the numbers the client and relay agree on", () => {
    expect(HTTP_MISDIRECTED).toBe(421);
    expect(WS_RESHARD_CODE).toBe(4421);
    expect(RESHARD_SENTINEL).toBe("reshard");
  });
});

describe("reshardReason / parseReshardReason", () => {
  it("builds the bare and owner-carrying forms", () => {
    expect(reshardReason()).toBe("reshard");
    expect(reshardReason("relay2.iterm2.com")).toBe("reshard relay2.iterm2.com");
  });

  it("parses the bare form", () => {
    expect(parseReshardReason("reshard")).toEqual({ isReshard: true, owner: null });
  });

  it("parses the owner hint", () => {
    expect(parseReshardReason("reshard relay2.iterm2.com"))
      .toEqual({ isReshard: true, owner: "relay2.iterm2.com" });
  });

  it("round-trips", () => {
    expect(parseReshardReason(reshardReason("relay7:8443")).owner).toBe("relay7:8443");
  });

  it("does not match a non-sentinel reason", () => {
    expect(parseReshardReason("daily quota exceeded").isReshard).toBe(false);
    expect(parseReshardReason("displaced").isReshard).toBe(false);
    expect(parseReshardReason("reshardxyz").isReshard).toBe(false); // whole-token only
    expect(parseReshardReason("").isReshard).toBe(false);
  });
});

describe("classifyWsClose", () => {
  it("classifies re-resolve", () => {
    expect(classifyWsClose({ code: 4421, reason: "reshard" })).toBe(Category.RE_RESOLVE);
    expect(classifyWsClose({ code: 4421, reason: "reshard relay2" })).toBe(Category.RE_RESOLVE);
    // A stack that surfaces only the reason still detects it.
    expect(classifyWsClose({ code: 1006, reason: "reshard relay2" })).toBe(Category.RE_RESOLVE);
  });

  it("classifies long-backoff by reason", () => {
    expect(classifyWsClose({ code: 1008, reason: "daily quota exceeded" })).toBe(Category.LONG_BACKOFF);
    expect(classifyWsClose({ code: 1000, reason: "displaced" })).toBe(Category.LONG_BACKOFF);
  });

  it("classifies other closes as retry-here (1008 is reason-disambiguated)", () => {
    expect(classifyWsClose({ code: 1008, reason: "frame rate exceeded" })).toBe(Category.RETRY_HERE);
    expect(classifyWsClose({ code: 1008, reason: "bad hello" })).toBe(Category.RETRY_HERE);
    expect(classifyWsClose({ code: 1008, reason: "admission timeout" })).toBe(Category.RETRY_HERE);
    expect(classifyWsClose({ code: 1000, reason: "" })).toBe(Category.RETRY_HERE);
    expect(classifyWsClose({ code: 1011, reason: "" })).toBe(Category.RETRY_HERE);
    expect(classifyWsClose({ code: 1006, reason: "" })).toBe(Category.RETRY_HERE);
    expect(classifyWsClose({ code: 1001, reason: "server shutting down" })).toBe(Category.RETRY_HERE);
  });
});

describe("classifyHttpStatus", () => {
  it("classifies the enumerated statuses", () => {
    expect(classifyHttpStatus(421)).toBe(Category.RE_RESOLVE);
    expect(classifyHttpStatus(429)).toBe(Category.RETRY_HERE);
    expect(classifyHttpStatus(503)).toBe(Category.RETRY_HERE);
    expect(classifyHttpStatus(500)).toBe(Category.RETRY_HERE);
    expect(classifyHttpStatus(403)).toBe(Category.FATAL);
    expect(classifyHttpStatus(413)).toBe(Category.FATAL);
  });
});
