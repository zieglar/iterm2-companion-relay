// A tiny persistent key/value store backed by one JSON file per key. It exposes
// exactly the subset of the Cloudflare KV interface the monitor's run() uses --
// get(key, "json") and put(key, string) -- so the analysis core (core.js) is
// unchanged from the Worker era; only the storage under it moved from KV to the
// local disk of the box you run this on. No more KV write-per-push quota (the
// original spam), because a local file has no daily write cap.
//
// Writes are atomic (write a temp file, then rename over the target) so a crash
// or power loss mid-write leaves the previous good value in place rather than a
// truncated JSON file that would poison every later read.

import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { join } from "node:path";

export function fileStore(dir) {
  const path = (key) => join(dir, `${key}.json`);
  return {
    // Mirrors KV.get(key, "json"): missing key -> null; "json" parses, otherwise
    // returns the raw string.
    async get(key, type) {
      let raw;
      try {
        raw = await readFile(path(key), "utf8");
      } catch (e) {
        if (e.code === "ENOENT") return null;
        throw e;
      }
      return type === "json" ? JSON.parse(raw) : raw;
    },
    // Mirrors KV.put(key, string). `val` is always a JSON string from the caller.
    async put(key, val) {
      await mkdir(dir, { recursive: true });
      const p = path(key);
      const tmp = `${p}.tmp`;
      await writeFile(tmp, val, "utf8");
      await rename(tmp, p); // atomic on the same filesystem
    },
  };
}
