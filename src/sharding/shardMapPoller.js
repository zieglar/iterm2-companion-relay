// Distributed-mode only: drives the ShardMapStore from the CDN. One fetch step
// is fetch -> parse -> validate -> store.applyFetched; ANY failure (network,
// malformed JSON, invalid partition) routes to store.applyFetchError() so the
// last-known-good map survives a bad fetch and a fetched-but-invalid map never
// wipes a good one. Polling is a thin setInterval over fetchOnce(). The actual
// egress is injected (`fetchText`) so this is unit-testable without a network.
// See docs/companion-relay-design.md (§6.5, §6.6, §6.8).

import { parseShardMap, validateShardMap } from "./shardMap.js";

export class ShardMapPoller {
  constructor({ url, fetchText, store, onAdopt, onError, log }) {
    this._url = url;
    this._fetchText = fetchText;
    this._store = store;
    this._onAdopt = onAdopt;
    this._onError = onError;
    this._log = log || (() => {});
    this._timer = null;
  }

  async fetchOnce() {
    let text;
    try {
      text = await this._fetchText(this._url);
    } catch (error) {
      this._store.applyFetchError();
      this._log(`shardmap fetch failed: ${error && error.message}`);
      if (this._onError) this._onError(error);
      return { ok: false, stage: "fetch", error };
    }

    let map;
    try {
      map = parseShardMap(text);
      validateShardMap(map);
    } catch (error) {
      // A fetched-but-invalid map must NOT be adopted (it would wipe a good one).
      this._store.applyFetchError();
      this._log(`shardmap invalid: ${error && error.message}`);
      if (this._onError) this._onError(error);
      return { ok: false, stage: "parse", error };
    }

    const diff = this._store.applyFetched(map);
    if (diff.adopted && this._onAdopt) this._onAdopt(map, diff);
    return {
      ok: true,
      adopted: diff.adopted,
      acquired: diff.acquired,
      relinquished: diff.relinquished,
      version: map.version,
    };
  }

  start(intervalMs, { setInterval: si = setInterval } = {}) {
    this.stop();
    this._timer = si(() => { this.fetchOnce().catch(() => {}); }, intervalMs);
    if (this._timer && typeof this._timer.unref === "function") this._timer.unref();
  }

  stop() {
    if (this._timer !== null) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }
}
