# iTerm2 shard-map resolver (Cloudflare Worker)

Serves the resolved-mode shard map at **`https://resolver.iterm2.com/shardmap.json`**,
entirely at the Cloudflare edge. The document is **embedded in the Worker
bundle** (`src/shardmap.json`, inlined at build time) — no R2, no KV, no origin
dependency, so it stays up even if the web server is down.

## Properties

- **Live in seconds.** A Worker deploy propagates globally in seconds, and
  Cloudflare does not edge-cache a Worker's own response, so a redeploy is served
  immediately at the edge. (`Cache-Control: max-age=5` is the hint to
  *downstream* HTTP caches; the relays' fetcher does not use an HTTP cache, so
  they get fresh content on their next poll. See "Caching" below.)
- **No origin fallthrough.** The whole `resolver.iterm2.com/*` subdomain routes
  to the Worker, which answers every request itself (200 for `/shardmap.json`,
  404 for any other path, 405 for non-GET/HEAD). Nothing ever reaches the origin.
- **Free plan, cannot bill.** Just the Worker + the embedded JSON: no KV, R2,
  Durable Objects, Queues, or observability. On the free plan, requests over the
  daily limit are throttled, never charged.
- **Correct HTTP.** `Content-Type: application/json`, a strong SHA-256 `ETag`,
  `304` on a matching `If-None-Match`, `HEAD` supported, `405` (with `Allow`) for
  other methods.

## One-time setup

1. **Auth** (uses your Cloudflare login):
   ```sh
   cd resolver
   npm install          # installs wrangler (the only dependency)
   npx wrangler login    # or set CLOUDFLARE_API_TOKEN
   ```

2. **DNS.** Worker routes only run on *proxied* traffic, so `resolver.iterm2.com`
   needs a proxied DNS record. It never actually serves from the origin (the
   Worker answers everything), so point it at a dummy address:

   > In the Cloudflare dashboard for `iterm2.com` -> DNS -> Add record:
   > **A** · name `resolver` · IPv4 `192.0.2.1` · **Proxied (orange cloud)**.

   (`192.0.2.1` is RFC 5737 documentation space, non-routable — it exists only so
   Cloudflare will proxy the hostname; the Worker route intercepts before any
   origin connection. An `AAAA resolver -> 100::` proxied record works equally.)

## Deploy

```sh
cd resolver
npm run deploy        # == wrangler deploy
```

Wrangler will confirm the route `resolver.iterm2.com/*` on zone `iterm2.com`.

## Update the shard map

Editing the document does **not** touch code:

1. Edit **`src/shardmap.json`** and **bump `"version"`** (it must strictly
   increase — relays and clients ignore a same-or-lower version, by design).
2. `npm run deploy`.

Live within seconds. Verify:

```sh
curl -i https://resolver.iterm2.com/shardmap.json
```

> The committed `src/shardmap.json` is a **template** (hosts `relay1.iterm2.com` /
> `relay2.iterm2.com`, 50/50). Replace the `host` values with your real relay
> authorities before pointing clients at it. Each `host` is a bare authority
> (lowercase `host` or `host:port`, no scheme/path), and must byte-match that
> relay's TLS-cert name, `RELAY_SELF_HOST`, and `RELAY_ORIGIN` (minus `https://`).

Clients set the pairing QR's `resolver=` to `https://resolver.iterm2.com/`, and
the relays set `RELAY_SHARDMAP_URL=https://resolver.iterm2.com/shardmap.json`.

## Caching (`max-age=5` is a design invariant, not a tuning knob)

- **The edge does not cache the Worker's response** — the Worker runs on every
  request and returns the currently-deployed document. So a redeploy is live at
  the edge in seconds.
- `Cache-Control: public, max-age=5` is the value the design mandates (§6.3,
  Appendix C), and it is load-bearing for the **client** re-resolve path. On a
  reshard the losing relay evicts a room with WS 4421 (or rejects with HTTP 421)
  and the client "forces a map refresh", but the client fetches the map with an
  ordinary protocol-caching HTTP client, so that refresh only sees the new map
  once the cached copy has expired. A long `max-age` (or any
  `stale-while-revalidate`) would hand the evicted client its stale map, bounce
  it back to the old owner, and 421-ping-pong it until the cache expired. Five
  seconds bounds that window; the `ETag` makes each revalidation a cheap `304`.
- The **relays** fetch with a plain HTTP client (no cache), so they always see
  the deployed content on their next poll regardless of this header.

## Files

```
wrangler.jsonc     route (whole subdomain), workers_dev off, no bindings
src/worker.js      the Worker (serve / 304 / 405 / 404); imports the JSON
src/shardmap.json  the document (edit this; bump version; redeploy)
package.json       wrangler devDependency + deploy script
```
