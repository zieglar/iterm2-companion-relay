// The relay runs in one of two modes. DIRECT is today's behavior and what
// self-hosters run: the box owns every bucket implicitly, never fetches a map,
// never rejects on ownership, never drains. DISTRIBUTED is the sharded fleet:
// ownership comes from a CDN shard map and the box drains on reshard.
//
// Mode is inferred from config so a self-hoster needs zero new config and cannot
// half-enable sharding: distributed requires BOTH a shard-map URL and a
// self-identity host; neither means direct; exactly one is a misconfiguration.
// See docs/companion-relay-design.md (§6.1, §6.8, §6.10).
//
// STUB: not yet implemented (tests are written first, TDD red).

export const MODE_DIRECT = "direct";
export const MODE_DISTRIBUTED = "distributed";

// resolveMode(config) -> "direct" | "distributed"
// config: { shardMapUrl?: string, selfHost?: string, ... }. A missing or
// empty-string value counts as absent. Throws if exactly one is present.
export function resolveMode(config) {
  throw new Error("not implemented: resolveMode");
}
