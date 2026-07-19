// The proof origin: origin = "https://" + host, byte-identical to the map/cert
// and to the client's construction. See docs/companion-relay-design.md (§6.10).

import { describe, it, expect } from "vitest";
import { originForHost, assertOriginMatches } from "../../src/sharding/origin.js";

describe("originForHost", () => {
  it("prepends https:// to a DNS name", () => {
    expect(originForHost("relay1.iterm2.com")).toBe("https://relay1.iterm2.com");
  });

  it("keeps an explicit port", () => {
    expect(originForHost("relay1.iterm2.com:8443")).toBe("https://relay1.iterm2.com:8443");
  });

  it("keeps a bare IPv4 literal", () => {
    expect(originForHost("203.0.113.7")).toBe("https://203.0.113.7");
  });

  it("keeps a bracketed IPv6 authority verbatim", () => {
    expect(originForHost("[2001:db8::1]:8443")).toBe("https://[2001:db8::1]:8443");
  });

  it("does NOT normalize (verbatim, so it can match the map byte-for-byte)", () => {
    // Accidental lowercasing or trailing-dot stripping would break the proof match.
    expect(originForHost("Relay1.iterm2.com")).toBe("https://Relay1.iterm2.com");
    expect(originForHost("relay1.iterm2.com.")).toBe("https://relay1.iterm2.com.");
  });
});

describe("assertOriginMatches", () => {
  it("passes when the configured origin equals https:// + host", () => {
    expect(() => assertOriginMatches("https://relay1.iterm2.com", "relay1.iterm2.com")).not.toThrow();
    expect(() => assertOriginMatches("https://relay1.iterm2.com:8443", "relay1.iterm2.com:8443")).not.toThrow();
  });

  it("throws on a byte mismatch (case, port, trailing dot, scheme)", () => {
    expect(() => assertOriginMatches("https://Relay1.iterm2.com", "relay1.iterm2.com")).toThrow();
    expect(() => assertOriginMatches("https://relay1.iterm2.com", "relay1.iterm2.com:8443")).toThrow();
    expect(() => assertOriginMatches("https://relay1.iterm2.com.", "relay1.iterm2.com")).toThrow();
    expect(() => assertOriginMatches("http://relay1.iterm2.com", "relay1.iterm2.com")).toThrow();
  });
});
