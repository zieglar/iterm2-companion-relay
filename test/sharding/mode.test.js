// Mode gating: direct (self-host default, today's behavior) vs distributed
// (sharded fleet), inferred from config presence. See
// docs/companion-relay-design.md (§6.1, §6.8).

import { describe, it, expect } from "vitest";
import { resolveMode, MODE_DIRECT, MODE_DISTRIBUTED } from "../../src/sharding/mode.js";

describe("resolveMode", () => {
  it("is direct when neither shardMapUrl nor selfHost is set", () => {
    expect(resolveMode({})).toBe(MODE_DIRECT);
    expect(resolveMode({ maxRooms: 200000 })).toBe(MODE_DIRECT);
    expect(resolveMode({ shardMapUrl: "", selfHost: "" })).toBe(MODE_DIRECT);
  });

  it("is distributed when both are set", () => {
    expect(resolveMode({
      shardMapUrl: "https://resolver.iterm2.com/shardmap.json",
      selfHost: "relay1.iterm2.com",
    })).toBe(MODE_DISTRIBUTED);
  });

  it("throws when exactly one is set (a misconfiguration, fail fast)", () => {
    expect(() => resolveMode({ shardMapUrl: "https://r/shardmap.json" })).toThrow();
    expect(() => resolveMode({ selfHost: "relay1.iterm2.com" })).toThrow();
    // Empty string on one side is still "only one present".
    expect(() => resolveMode({ shardMapUrl: "https://r/shardmap.json", selfHost: "" })).toThrow();
    expect(() => resolveMode({ shardMapUrl: "", selfHost: "relay1.iterm2.com" })).toThrow();
  });
});
