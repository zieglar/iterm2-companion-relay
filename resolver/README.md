# iTerm2 shard-map resolver (Cloudflare Worker)

Serves the resolved-mode shard map at **`https://resolver.iterm2.com/shardmap.json`**,
entirely at the Cloudflare edge. The document is **embedded in the Worker
bundle** (`src/shardmap.json`, inlined at build time) — no R2, no KV, no origin
dependency, so it stays up even if the web server is down.

## Properties

- **Live in seconds.** A Worker deploy propagates globally in seconds, and
  Cloudflare does not edge-cache a Worker's own response, so a redeploy is served
  immediately at the edge. (`Cache-Control: max-age=300` is the hint to
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

## Caching (why `max-age=300` does not fight "live in seconds")

- **The edge does not cache the Worker's response** — the Worker runs on every
  request and returns the currently-deployed document. So a redeploy is live at
  the edge in seconds.
- `Cache-Control: public, max-age=300, stale-while-revalidate=86400` tells
  *downstream* caches (browsers) they may reuse a copy for up to 5 minutes and
  serve stale for up to a day while revalidating. It does not delay a deploy.
- The **relays** fetch with a plain HTTP client (no cache), so they always see
  the deployed content on their next poll. A client that respects `max-age`
  trades a little freshness for fewer requests; the `ETag` makes revalidation a
  cheap `304`.

## Files

```
wrangler.jsonc     route (whole subdomain), workers_dev off, no bindings
src/worker.js      the Worker (serve / 304 / 405 / 404); imports the JSON
src/shardmap.json  the document (edit this; bump version; redeploy)
package.json       wrangler devDependency + deploy script
```
