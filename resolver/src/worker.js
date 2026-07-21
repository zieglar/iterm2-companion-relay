// iTerm2 shard-map resolver (Cloudflare Worker).
//
// Serves the resolved-mode shard map at
//   https://resolver.iterm2.com/shardmap.json
// entirely at the edge. The document is EMBEDDED in the Worker bundle (imported
// from ./shardmap.json and inlined at build time), so there is no R2, no KV, and
// no origin dependency: edit src/shardmap.json and `wrangler deploy` to publish
// (a deploy propagates globally in seconds). See README.md.
//
// The whole resolver.iterm2.com subdomain routes to this Worker (wrangler.jsonc),
// so a request can never fall through to the origin: any path other than
// /shardmap.json is a 404, any method other than GET/HEAD is a 405, and the
// Worker never fetch()es anything itself.

import shardmap from "./shardmap.json";

const PATH = "/shardmap.json";

// The exact bytes served to every client. Deterministic (JSON.stringify of the
// imported object) so the ETag is stable across identical deploys; trailing
// newline for friendlier `curl` output. Computed once at module load.
const BODY = JSON.stringify(shardmap) + "\n";
const BODY_BYTES = new TextEncoder().encode(BODY);

const CACHE_CONTROL = "public, max-age=300, stale-while-revalidate=86400";

// Strong ETag = quoted SHA-256 of the body (no W/ prefix). Computed lazily once
// and memoized, so there is no per-request hashing and no top-level await.
let etagPromise = null;
function etag() {
  if (!etagPromise) {
    etagPromise = crypto.subtle.digest("SHA-256", BODY_BYTES).then((digest) => {
      const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
      return `"${hex}"`;
    });
  }
  return etagPromise;
}

// RFC 7232 If-None-Match: a comma list of entity-tags, or "*". Match => 304.
function ifNoneMatchMatches(header, tag) {
  if (!header) return false;
  return header.split(",").some((t) => {
    const v = t.trim();
    return v === "*" || v === tag;
  });
}

function textResponse(status, message, extraHeaders) {
  return new Response(message + "\n", {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", ...extraHeaders },
  });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // Serve ONLY the intended path; everything else on the subdomain 404s here
    // (never reaching the origin).
    if (url.pathname !== PATH) {
      return textResponse(404, "not found");
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return textResponse(405, "method not allowed", { allow: "GET, HEAD" });
    }

    const tag = await etag();

    // Conditional request: unchanged => 304 with the validators, no body.
    if (ifNoneMatchMatches(request.headers.get("if-none-match"), tag)) {
      return new Response(null, {
        status: 304,
        headers: { etag: tag, "cache-control": CACHE_CONTROL },
      });
    }

    const headers = {
      "content-type": "application/json",
      "cache-control": CACHE_CONTROL,
      "content-length": String(BODY_BYTES.byteLength),
      etag: tag,
    };
    // HEAD: identical headers, no body.
    return new Response(request.method === "HEAD" ? null : BODY, { status: 200, headers });
  },
};
