// Unit tests for the aggregate metrics registry. Everything here must be
// non-identifying: counts and a socket-lifetime histogram, never a room name,
// room tag, or IP. (The endpoint wiring / localhost-only gating is tested in
// server.test.js.)

import { describe, it, expect } from "vitest";
import { Metrics } from "../../host/metrics.js";

describe("Metrics", () => {
  it("renders counters in Prometheus text format with HELP/TYPE", () => {
    const m = new Metrics();
    m.inc("ws_upgrades_total");
    m.inc("ws_upgrades_total");
    const out = m.render({});
    expect(out).toContain("# TYPE relay_ws_upgrades_total counter");
    expect(out).toMatch(/relay_ws_upgrades_total 2/);
  });

  it("counts daily-byte-quota tear-down closes as a plain counter", () => {
    const m = new Metrics();
    m.inc("quota_exceeded_total");
    m.inc("quota_exceeded_total");
    const out = m.render({});
    expect(out).toContain("# TYPE relay_quota_exceeded_total counter");
    expect(out).toMatch(/relay_quota_exceeded_total 2/);
    expect(m.snapshot().quota_exceeded_total).toBe(2);
  });

  it("labels rejection reasons", () => {
    const m = new Metrics();
    m.incReason("ws_upgrades_rejected_total", "rate_limited");
    m.incReason("ws_upgrades_rejected_total", "room_cap");
    m.incReason("ws_upgrades_rejected_total", "rate_limited");
    const out = m.render({});
    expect(out).toContain('relay_ws_upgrades_rejected_total{reason="rate_limited"} 2');
    expect(out).toContain('relay_ws_upgrades_rejected_total{reason="room_cap"} 1');
  });

  it("buckets socket lifetimes cumulatively (flap-cadence histogram)", () => {
    const m = new Metrics();
    m.observeSocketLifetime(0.5); // <=1s
    m.observeSocketLifetime(3); // <=5s
    m.observeSocketLifetime(120); // <=300s
    const out = m.render({});
    // Cumulative buckets: le=1 has 1, le=5 has 2, le=+Inf has 3.
    expect(out).toContain('relay_socket_lifetime_seconds_bucket{le="1"} 1');
    expect(out).toContain('relay_socket_lifetime_seconds_bucket{le="5"} 2');
    expect(out).toContain('relay_socket_lifetime_seconds_bucket{le="+Inf"} 3');
    expect(out).toContain("relay_socket_lifetime_seconds_count 3");
  });

  it("emits gauges passed at render time", () => {
    const m = new Metrics();
    const out = m.render({ rooms_live: 4, sockets_live: 7 });
    expect(out).toContain("# TYPE relay_rooms_live gauge");
    expect(out).toContain("relay_rooms_live 4");
    expect(out).toContain("relay_sockets_live 7");
  });

  it("carries no room names, tags, or IPs", () => {
    const m = new Metrics();
    m.inc("ws_upgrades_total");
    m.incReason("ws_upgrades_rejected_total", "ip_cap");
    m.observeSocketLifetime(10);
    const out = m.render({ rooms_live: 1, sockets_live: 1 });
    // Only the allowed reason label values appear; nothing free-form.
    expect(out).not.toMatch(/room=|tag=|ip=|[0-9a-f]{64}/);
  });

  describe("snapshot", () => {
    it("flattens counters (rejections summed) plus the supplied gauges", () => {
      const m = new Metrics();
      m.inc("ws_upgrades_total", 5);
      m.inc("http_requests_total", 40);
      m.inc("http_errors_total", 2);
      m.inc("process_exceptions_total", 1);
      m.incReason("ws_upgrades_rejected_total", "rate_limited");
      m.incReason("ws_upgrades_rejected_total", "ip_cap");
      const snap = m.snapshot({ rooms_live: 3, sockets_live: 6 });
      expect(snap).toEqual({
        ws_upgrades_total: 5,
        ws_upgrades_rejected_total: 2,
        http_requests_total: 40,
        http_errors_total: 2,
        process_exceptions_total: 1,
        quota_exceeded_total: 0,
        rooms_live: 3,
        sockets_live: 6,
        shard_reject_total: 0,
        shard_map_reloads_total: 0,
        shard_map_fetch_errors_total: 0,
        shard_map_version: -1,
        shard_owned_buckets: 0,
        shard_draining_buckets: 0,
      });
    });

    it("includes the shard counters and gauges in the push payload", () => {
      // The push payload is the ONLY off-box surface in the loopback-/metrics
      // posture, so reshard adoption, drain progress, ownership, and fetch
      // failures must all ride it or a distributed fleet is operated blind.
      const m = new Metrics();
      m.inc("shard_reject_total", 4);
      m.inc("shard_map_reloads_total", 2);
      m.inc("shard_map_fetch_errors_total", 1);
      const snap = m.snapshot({
        rooms_live: 0, sockets_live: 0,
        shard_map_version: 7, shard_owned_buckets: 32768, shard_draining_buckets: 3,
      });
      expect(snap.shard_reject_total).toBe(4);
      expect(snap.shard_map_reloads_total).toBe(2);
      expect(snap.shard_map_fetch_errors_total).toBe(1);
      expect(snap.shard_map_version).toBe(7);
      expect(snap.shard_owned_buckets).toBe(32768);
      expect(snap.shard_draining_buckets).toBe(3);
    });

    it("defaults every field to 0 on a fresh registry (map version -1 = none)", () => {
      const snap = new Metrics().snapshot();
      // shard_map_version is a gauge whose "no map adopted" sentinel is -1
      // (matching /metrics); every other field starts at 0.
      expect(snap.shard_map_version).toBe(-1);
      const { shard_map_version, ...rest } = snap;
      expect(Object.values(rest).every((v) => v === 0)).toBe(true);
    });
  });
});
