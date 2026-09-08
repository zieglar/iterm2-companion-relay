// Shard-map fetch-failure diagnosability: a persistent fetch failure must be
// attributable (dns vs network path vs Cloudflare vs bad body) from the journal
// and /metrics alone, without a live repro. Covers the classifier (pure) and the
// end-to-end wiring (per-cause counter + always-on throttled log).

import { describe, it, expect, vi } from "vitest";
import { createRelay, classifyShardFetchError } from "../../host/server.js";

const N = 65536;
const MAP_JSON = JSON.stringify({
  version: 7,
  ranges: [
    { low: 0, high: 49999, host: "relay2" },
    { low: 50000, high: N - 1, host: "relay1" },
  ],
});

// undici surfaces a network failure as `TypeError: fetch failed` with the real
// errno under .cause; build that shape so the classifier is tested as it is fed.
function fetchFailed(code) {
  const e = new TypeError("fetch failed");
  e.cause = { code };
  return e;
}
function httpErr(status, cfRay) {
  const e = new Error(`shardmap HTTP ${status}`);
  e.httpStatus = status;
  if (cfRay) e.cfRay = cfRay;
  return e;
}

describe("classifyShardFetchError", () => {
  it("maps DNS failures", () => {
    expect(classifyShardFetchError(fetchFailed("ENOTFOUND"))).toEqual({ cause: "dns", detail: "ENOTFOUND" });
    expect(classifyShardFetchError(fetchFailed("EAI_AGAIN")).cause).toBe("dns");
  });
  it("maps timeouts (errno, undici code, and AbortError)", () => {
    expect(classifyShardFetchError(fetchFailed("ETIMEDOUT")).cause).toBe("timeout");
    expect(classifyShardFetchError(fetchFailed("UND_ERR_CONNECT_TIMEOUT")).cause).toBe("timeout");
    const abort = new Error("aborted"); abort.name = "AbortError";
    expect(classifyShardFetchError(abort)).toEqual({ cause: "timeout", detail: "abort" });
  });
  it("maps connection failures", () => {
    expect(classifyShardFetchError(fetchFailed("ECONNREFUSED")).cause).toBe("conn");
    expect(classifyShardFetchError(fetchFailed("ECONNRESET")).cause).toBe("conn");
  });
  it("maps TLS failures", () => {
    expect(classifyShardFetchError(fetchFailed("CERT_HAS_EXPIRED")).cause).toBe("tls");
    expect(classifyShardFetchError(fetchFailed("ERR_TLS_CERT_ALTNAME_INVALID")).cause).toBe("tls");
  });
  it("splits HTTP errors and keeps the cf-ray for Cloudflare attribution", () => {
    expect(classifyShardFetchError(httpErr(503, "8f-abc"))).toEqual({ cause: "http_5xx", detail: "HTTP 503 cf-ray=8f-abc" });
    expect(classifyShardFetchError(httpErr(403)).cause).toBe("http_4xx");
  });
  it("maps parse/validation failures", () => {
    const validation = new Error("gap"); validation.kind = "coverage_gap";
    expect(classifyShardFetchError(validation)).toEqual({ cause: "parse", detail: "coverage_gap" });
    const syntax = new SyntaxError("Unexpected token");
    expect(classifyShardFetchError(syntax)).toEqual({ cause: "parse", detail: "json" });
  });
  it("falls back to other with a code or trimmed message", () => {
    expect(classifyShardFetchError(fetchFailed("EWHATEVER"))).toEqual({ cause: "other", detail: "EWHATEVER" });
    expect(classifyShardFetchError(new Error("weird")).cause).toBe("other");
    expect(classifyShardFetchError(null)).toEqual({ cause: "other", detail: "unknown" });
  });
});

async function boot(fetchText) {
  const relay = createRelay({
    env: { RELAY_ORIGIN: "https://relay1", RELAY_LOG: "false", ATTEST_REQUIRED: "false" },
    dbPath: ":memory:",
    shardMapUrl: "https://cdn/shardmap.json",
    selfHost: "relay1",
    fetchText,
    bootSleep: async () => {},
  });
  await relay.listen(0, "127.0.0.1");
  return { relay, base: `http://127.0.0.1:${relay.address().port}` };
}

describe("shard-map fetch-failure wiring", () => {
  it("counts a failure by cause on /metrics and logs an always-on FAILING line", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let boot0 = true;
    const fetchText = async () => {
      if (boot0) { boot0 = false; return MAP_JSON; }
      throw fetchFailed("ENOTFOUND");
    };
    const { relay, base } = await boot(fetchText);
    try {
      await relay.shardPoller.fetchOnce(); // one failing poll after boot
      const text = await (await fetch(base + "/metrics")).text();
      expect(text).toContain('relay_shard_map_fetch_errors_by_cause_total{reason="dns"} 1');
      expect(text).toMatch(/relay_shard_map_fetch_errors_total \d+/);
      const logged = warn.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logged).toMatch(/shardmap fetch FAILING cause=dns detail=ENOTFOUND/);
    } finally {
      await relay.close();
      warn.mockRestore();
    }
  });

  it("logs a RECOVERED line (with duration) when a fetch succeeds after failures", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let n = 0;
    const fetchText = async () => {
      n += 1;
      if (n === 1) return MAP_JSON;        // boot
      if (n === 2) throw fetchFailed("ETIMEDOUT"); // one failure
      return MAP_JSON;                     // then recover
    };
    const { relay } = await boot(fetchText);
    try {
      await relay.shardPoller.fetchOnce(); // fails
      await relay.shardPoller.fetchOnce(); // recovers
      const logged = warn.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logged).toMatch(/shardmap fetch FAILING cause=timeout/);
      expect(logged).toMatch(/shardmap fetch RECOVERED after streak=1 over \d+s/);
    } finally {
      await relay.close();
      warn.mockRestore();
    }
  });
});
