import { describe, expect, it } from "vitest";
import { createBoundedCache } from "../bounded-cache";

describe("Bounded Cache Invalidation and Stale Detection (#455)", () => {
  const maintainer = { role: "maintainer", permissions: ["admin:recovery"] };
  const viewer = { role: "viewer", permissions: [] };

  describe("Normal Path", () => {
    it("respects maxEntries capacity and evicts LRU entries", () => {
      let now = 1_000;
      const cache = createBoundedCache<string>({ maxEntries: 2, ttlMs: 10_000, now: () => now });

      cache.set("a", "alpha");
      cache.set("b", "beta");
      expect(cache.stats().size).toBe(2);

      // Touch 'a' to make 'b' LRU
      expect(cache.get("a")).toEqual({ ok: true, value: "alpha" });

      // Add 'c', which should evict 'b'
      cache.set("c", "gamma");
      expect(cache.stats().size).toBe(2);
      expect(cache.get("b")).toEqual({ ok: false, code: "cache_miss" });
      expect(cache.get("a")).toEqual({ ok: true, value: "alpha" });
      expect(cache.get("c")).toEqual({ ok: true, value: "gamma" });
    });
  });

  describe("Failure Path", () => {
    it("detects TTL expiration and ledger sequence staleness", () => {
      let now = 1_000;
      const cache = createBoundedCache<string>({ maxEntries: 5, ttlMs: 2_000, now: () => now });

      cache.set("item-1", "val-1", { ledgerSequence: 50 });
      now += 3_000;

      // TTL expired
      expect(cache.get("item-1")).toEqual({ ok: false, code: "cache_expired" });

      // Head stale read
      cache.set("ledger-item", "fresh-val", { ledgerSequence: 100 });
      expect(cache.get("ledger-item", { minLedgerSequence: 120 })).toEqual({ ok: false, code: "cache_stale" });

      // Stale write rejection
      const staleWrite = cache.set("ledger-item", "older-val", { ledgerSequence: 90 });
      expect(staleWrite).toEqual({ ok: false, code: "cache_stale_write" });
    });
  });

  describe("Retry Path", () => {
    it("retries failed loader in getOrLoad without poisoning the cache", async () => {
      const cache = createBoundedCache<string>({ maxEntries: 5, ttlMs: 5_000 });
      let callCount = 0;

      const loader = async () => {
        callCount++;
        if (callCount === 1) return { ok: false, code: "timeout" };
        return { ok: true, value: "loaded-val" };
      };

      const res1 = await cache.getOrLoad("load-key", loader);
      expect(res1.ok).toBe(false);
      expect(cache.get("load-key").ok).toBe(false);

      const res2 = await cache.getOrLoad("load-key", loader);
      expect(res2.ok).toBe(true);
      expect(res2.value).toBe("loaded-val");
      expect(cache.get("load-key")).toEqual({ ok: true, value: "loaded-val" });
    });
  });

  describe("Authorization Path", () => {
    it("requires admin:recovery permission for evictStale and clear operations", () => {
      let now = 1_000;
      const cache = createBoundedCache<string>({ maxEntries: 5, ttlMs: 1_000, now: () => now });

      cache.set("sweep-1", "v1");
      cache.set("sweep-2", "v2");
      now += 2_000;

      const unauthResult = cache.evictStale(viewer, "routine maintenance");
      expect(unauthResult).toEqual({ ok: false, code: "cache_unauthorized" });

      const authResult = cache.evictStale(maintainer, "routine maintenance");
      expect(authResult.ok).toBe(true);
      expect(cache.stats().size).toBe(0);
    });

    it("drops all projections of an entity via invalidateEntity", () => {
      const cache = createBoundedCache<string>({ maxEntries: 10, ttlMs: 5_000 });
      cache.set("user:1:profile", "prof", { sourceEntityId: "user-1" });
      cache.set("user:1:balances", "bal", { sourceEntityId: "user-1" });
      cache.set("user:2:profile", "prof2", { sourceEntityId: "user-2" });

      const count = cache.invalidateEntity("user-1");
      expect(count).toBe(2);
      expect(cache.get("user:1:profile")).toEqual({ ok: false, code: "cache_miss" });
      expect(cache.get("user:1:balances")).toEqual({ ok: false, code: "cache_miss" });
      expect(cache.get("user:2:profile")).toEqual({ ok: true, value: "prof2" });
    });
  });
});
