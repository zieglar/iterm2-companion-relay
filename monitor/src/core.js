// The transport-agnostic orchestration for one monitor tick. Extracted from the
// old Cloudflare Worker's run() unchanged in logic; the only difference is that
// its three side effects are now injected instead of hard-wired to Workers APIs:
//
//   kv        - persistence         (fileStore in prod; a Map fake in tests)
//   runProbe  - the outside-in probe (a real ws handshake in prod; a stub in tests)
//   sendEmail - alert delivery       (Resend in prod; a stub in tests)
//
// Keeping run() free of any concrete transport is what lets it stay unit-tested
// with no network, exactly as it was under the Worker. The pure analysis lives in
// monitor.js; this file only wires the checks to state and delivery.

import {
  parseConfig, normalizeSnapshot, deltas, rollHour, hourKey, analyze, dueAlerts,
  livenessAlert, probeAlert,
} from "./monitor.js";

export const LATEST_KEY = "latest";
export const STATE_KEY = "state";

// env: the flat config/secrets object (process.env in prod). now: ms timestamp.
// deps: { dry, kv, runProbe, sendEmail }. Returns a summary for the dry-run/JSON
// endpoints; when !dry it also persists state and (tries to) send due alerts.
export async function run(env, now, { dry, kv, runProbe, sendEmail }) {
  const cfg = parseConfig(env);
  const latest = await kv.get(LATEST_KEY, "json");
  const state = dry ? {} : ((await kv.get(STATE_KEY, "json")) || {});
  const ageMs = latest ? now - latest.receivedAt : null;

  let alerts;
  const nextState = { ...state };
  if (!latest || ageMs > cfg.staleMs) {
    // Dead-man's-switch: no fresh push means the relay or its host is down.
    // Preserve the metric-derived state (prev/anchor/history) so it resumes
    // cleanly once pushes return.
    const detail = latest ? `no snapshot for ${Math.round(ageMs / 60000)} min` : "no snapshot received yet";
    alerts = [livenessAlert(detail)];
  } else {
    const snap = normalizeSnapshot(latest.snapshot);
    const interval = deltas(state.prev, snap.counters);
    const roll = rollHour(state.hourAnchor, snap.counters, hourKey(now));
    const analyzed = analyze({ gauges: snap.gauges, interval, lastHour: roll.lastHour }, state, cfg);
    alerts = analyzed.alerts;
    nextState.history = analyzed.history;
    nextState.lastRecordedHour = analyzed.lastRecordedHour;
    nextState.prev = snap.counters;
    nextState.hourAnchor = roll.anchor;
  }

  // Independent outside-in synthetic probe: a real pairing handshake through
  // the full inbound path. Catches the failure class the push cannot see --
  // process up and pushing, but users can't connect. Opt-in via RELAY_PROBE_URL
  // (single direct-mode relay, random room) or SHARD_MAP_URL (distributed
  // fleet: every map host is probed with a room it owns; see fleetProbe).
  let probe = null;
  if ((env.RELAY_PROBE_URL || env.SHARD_MAP_URL) && runProbe) {
    probe = await runProbe(
      { probeUrl: env.RELAY_PROBE_URL || "", shardMapUrl: env.SHARD_MAP_URL || "" },
      cfg.probeTimeoutMs,
    );
    if (!probe.ok) alerts.push(probeAlert(probe.detail));
  }

  const { due, sentAt } = dueAlerts(alerts, state.sentAt || {}, now, cfg.cooldownMs);

  if (!dry) {
    let delivered = true;
    if (due.length) {
      try {
        await sendEmail(env, due);
      } catch (e) {
        // A transient delivery failure (Resend 429/5xx, network, bad key, unset
        // ALERT_*) must not lose state. Fall through and persist anyway.
        delivered = false;
        console.error("relay-monitor: alert send failed:", (e && e.message) || e);
      }
    }
    // Always advance the metric-derived state (prev/hourAnchor/history) so a send
    // failure can't freeze the baselines. Advance the cooldown (sentAt) only when
    // the send actually went out; otherwise keep the prior sentAt so the due
    // alerts are due again next tick and retry, rather than being recorded as
    // sent-but-undelivered (which would silently drop a real outage alert).
    nextState.sentAt = delivered ? sentAt : (state.sentAt || {});
    await kv.put(STATE_KEY, JSON.stringify(nextState));
  }
  return { ageMs, probe, alerts, due: due.map((a) => a.key) };
}
