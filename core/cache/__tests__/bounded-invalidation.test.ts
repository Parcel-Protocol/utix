import { afterEach, describe, expect, it } from "vitest";
import { err, ok, type Result } from "@/core/result/result";
import { createCaptureSink, resetTelemetrySink, setTelemetrySink } from "@/core/telemetry/telemetry";
import { createBoundedCache, DEFAULT_SWEEP_SCAN, type BoundedCacheOptions } from "../bounded-cache";

const START = Date.parse("2026-11-21T00:00:00.000Z");
const MAINTAINER = { role: "maintainer" } as const;

function harness(overrides: Partial<BoundedCacheOptions> = {}) {
  let clock = START;
  const cache = createBoundedCache<string>({ maxEntries: 5, ttlMs: 1_000, now: () => clock, name: "horizon.accounts", ...overrides });
  return { cache, advance: (ms: number) => (clock += ms) };
}

afterEach(() => resetTelemetrySink());

describe("bounded cache invalidation and stale detection (#411)", () => {
  describe("normal path: read-time freshness", () => {
    it("serves an entry at or after the caller's ledger head", () => {
      const { cache } = harness();
      cache.set("balance:GA", "100.0000000", { ledgerSequence: 900 });

      expect(cache.get("balance:GA", { minLedgerSequence: 900 })).toEqual(ok("100.0000000"));
      expect(cache.get("balance:GA", { minLedgerSequence: 899 })).toEqual(ok("100.0000000"));
    });

    it("evicts an entry behind the head, so no later reader gets it either", () => {
      const { cache } = harness();
      cache.set("balance:GA", "100.0000000", { ledgerSequence: 900 });

      expect(cache.get("balance:GA", { minLedgerSequence: 901 })).toEqual(err("cache_stale"));
      expect(cache.get("balance:GA")).toEqual(err("cache_miss"));
      expect(cache.stats()).toMatchObject({ staleReads: 1, invalidations: 1, size: 0 });
    });

    it("refuses an entry with no ledger sequence to a head-aware reader, but keeps it for others", () => {
      const { cache } = harness();
      cache.set("toml:example.com", "VERSION=2.0.0");

      expect(cache.get("toml:example.com", { minLedgerSequence: 1 })).toEqual(err("cache_stale"));
      expect(cache.get("toml:example.com")).toEqual(ok("VERSION=2.0.0"));
    });

    it("applies a tighter per-read age limit without evicting for looser readers", () => {
      const { cache, advance } = harness();
      cache.set("fees", "100");
      advance(500);

      expect(cache.get("fees", { maxAgeMs: 500 })).toEqual(ok("100"));
      expect(cache.get("fees", { maxAgeMs: 499 })).toEqual(err("cache_stale"));
      expect(cache.get("fees")).toEqual(ok("100"));
    });

    it("leaves callers without read options on the original two error codes", () => {
      const { cache, advance } = harness();
      cache.set("k", "v", { ledgerSequence: 1 });
      advance(1_001);
      expect(cache.get("k")).toEqual(err("cache_expired"));
      expect(cache.get("k")).toEqual(err("cache_miss"));
    });
  });

  describe("normal path: bounded invalidation", () => {
    it("invalidates every projection of one entity in O(k), leaving the rest", () => {
      const { cache } = harness();
      cache.set("balances:GA", "1", { sourceEntityId: "GA" });
      cache.set("offers:GA", "2", { sourceEntityId: "GA" });
      cache.set("balances:GB", "3", { sourceEntityId: "GB" });
      cache.set("fees", "4");

      expect(cache.invalidateEntity("GA")).toBe(2);
      expect(cache.snapshot().map((entry) => entry.key)).toEqual(["balances:GB", "fees"]);
      expect(cache.invalidateEntity("GA")).toBe(0);
      expect(cache.invalidateEntity("unknown")).toBe(0);
    });

    it("keeps the entity index in step with overwrites, evictions and clear", () => {
      const { cache } = harness({ maxEntries: 2 });
      cache.set("a", "1", { sourceEntityId: "GA" });
      // Re-pointing a key at another entity unlinks it from the first.
      cache.set("a", "2", { sourceEntityId: "GB" });
      expect(cache.invalidateEntity("GA")).toBe(0);

      cache.set("b", "3", { sourceEntityId: "GB" });
      cache.set("c", "4", { sourceEntityId: "GC" }); // evicts "a"
      expect(cache.invalidateEntity("GB")).toBe(1);

      cache.clear(MAINTAINER, "test");
      expect(cache.invalidateEntity("GC")).toBe(0);
    });

    it("cancels a load in flight for an invalidated entity, even with nothing stored yet", async () => {
      const { cache } = harness();
      let resolve!: (value: Result<string, "load_failed">) => void;
      const load = () => new Promise<Result<string, "load_failed">>((settle) => (resolve = settle));

      const pending = cache.getOrLoad("balances:GA", load, { sourceEntityId: "GA" });
      const other = cache.getOrLoad("balances:GB", async () => ok("gb"), { sourceEntityId: "GB" });
      await Promise.resolve();
      cache.invalidateEntity("GA");
      resolve(ok("read-before-invalidation"));

      // The caller still gets its value, but a response from before the
      // invalidation is never stored over it.
      expect(await pending).toEqual(ok("read-before-invalidation"));
      expect(cache.get("balances:GA")).toEqual(err("cache_miss"));
      expect(await other).toEqual(ok("gb"));
      expect(cache.get("balances:GB")).toEqual(ok("gb"));
    });

    it("sweeps expired entries in bounded steps, least recently used first", () => {
      const { cache, advance } = harness();
      for (const key of ["a", "b", "c", "d"]) cache.set(key, key);
      advance(600);
      cache.set("fresh", "f");
      advance(500);

      expect(cache.sweepExpired(2)).toEqual({ examined: 2, removed: 2 });
      expect(cache.sweepExpired()).toEqual({ examined: 3, removed: 2 });
      expect(cache.snapshot().map((entry) => entry.key)).toEqual(["fresh"]);
      expect(cache.stats().expirations).toBe(4);
      expect(DEFAULT_SWEEP_SCAN).toBe(100);
    });
  });

  describe("failure path", () => {
    it.each([Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 2])(
      "refuses ledger sequence %s instead of disabling the stale-write guard",
      (sequence) => {
        const { cache } = harness();
        expect(() => cache.set("k", "v", { ledgerSequence: sequence })).toThrow(RangeError);
        expect(() => cache.get("k", { minLedgerSequence: sequence })).toThrow(RangeError);
      }
    );

    it("refuses a non-positive sweep bound", () => {
      const { cache } = harness();
      expect(() => cache.sweepExpired(0)).toThrow(RangeError);
    });

    it("inspect reports expiry, schema skew and drift without changing anything", () => {
      const { cache, advance } = harness();
      cache.set("old", "1");
      advance(1_001);
      cache.set("behind", "2", { ledgerSequence: 100 });
      cache.set("current", "3", { ledgerSequence: 200 });

      const report = cache.inspect({ authoritativeLedgerSequence: 200 });
      expect(report.findings.map((finding) => [finding.targetKey, finding.staleReason])).toEqual([
        ["old", "ttl_expired"],
        ["behind", "ledger_drift"]
      ]);
      expect(cache.stats().size).toBe(3);

      // A schema bump past the cache's stamp flags every entry.
      expect(cache.inspect({ currentSchemaVersion: 2 }).staleCachesCount).toBe(3);
    });
  });

  describe("retry path", () => {
    it("reloads through getOrLoad when the cached entry is behind the head", async () => {
      const { cache } = harness();
      cache.set("balance:GA", "old", { ledgerSequence: 10 });
      let loads = 0;
      const load = async (): Promise<Result<string, "load_failed">> => {
        loads += 1;
        return loads === 1 ? err("load_failed") : ok("fresh");
      };

      expect(await cache.getOrLoad("balance:GA", load, { minLedgerSequence: 11, ledgerSequence: 11 })).toEqual(err("load_failed"));
      // A failed load is not cached; the next call retries it.
      expect(await cache.getOrLoad("balance:GA", load, { minLedgerSequence: 11, ledgerSequence: 11 })).toEqual(ok("fresh"));
      expect(cache.get("balance:GA", { minLedgerSequence: 11 })).toEqual(ok("fresh"));
      expect(loads).toBe(2);
    });

    it("can rerun evictStale safely: a second pass finds nothing", () => {
      const { cache, advance } = harness();
      cache.set("old", "1");
      advance(1_001);
      expect(cache.evictStale(MAINTAINER, "sweep")).toMatchObject({ ok: true, value: { evicted: ["old"] } });
      expect(cache.evictStale(MAINTAINER, "sweep")).toMatchObject({ ok: true, value: { evicted: [] } });
    });
  });

  describe("authorization path", () => {
    it("evicts flagged entries for admin:recovery and records it", () => {
      const sink = createCaptureSink();
      setTelemetrySink(sink);
      const { cache } = harness();
      cache.set("behind", "1", { ledgerSequence: 1 });
      cache.set("current", "2", { ledgerSequence: 50 });

      const outcome = cache.evictStale(MAINTAINER, "head moved", { authoritativeLedgerSequence: 50 });
      expect(outcome.ok && outcome.value.evicted).toEqual(["behind"]);
      expect(cache.snapshot().map((entry) => entry.key)).toEqual(["current"]);
      expect(sink.events.at(-1)).toMatchObject({
        op: "cache.stale_evicted",
        result: "success",
        payload: { cache: "horizon.accounts", evicted: 1, reasons: ["ledger_drift"], reason: "head moved" }
      });
    });

    it("refuses viewers and services and leaves the cache untouched", () => {
      const sink = createCaptureSink();
      setTelemetrySink(sink);
      const { cache, advance } = harness();
      cache.set("old", "1");
      advance(1_001);

      for (const role of ["viewer", "service"] as const) {
        expect(cache.evictStale({ role }, "nope")).toEqual(err("cache_unauthorized"));
      }
      expect(cache.snapshot()).toHaveLength(1);
      expect(sink.events.at(-1)).toMatchObject({ op: "cache.stale_evicted", result: "failure", errorCode: "cache_unauthorized" });
    });
  });
});
