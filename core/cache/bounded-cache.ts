/**
 * Bounded cache with explicit invalidation and stale detection (#270)
 *
 * A least-recently-used cache for projections of ledger state (Horizon and RPC
 * reads). It never grows past `maxEntries`, and it never serves a value that
 * the stale rules in `StaleProjectionDetector` would flag:
 *
 * - an entry older than its TTL is `cache_expired`;
 * - a write carrying an older ledger sequence than the entry it would replace
 *   is refused as `cache_stale_write`, so an out-of-order response cannot roll
 *   a projection back.
 *
 * Expired entries are dropped when they are read, so expiry costs nothing
 * until the key is touched again. `snapshot()` exposes the live entries in the
 * `CacheEntry` shape (stamped with `schemaVersion`), so the existing detector
 * reports schema skew, ledger drift and orphans for this cache as-is.
 *
 * Bounded invalidation and read-time stale detection (#411):
 *
 * - `get(key, { minLedgerSequence, maxAgeMs })` refuses an entry that is
 *   behind a known ledger head, or older than the caller can tolerate, as
 *   `cache_stale`, so a reader that knows the head never gets a projection
 *   from before it. An entry behind the head is evicted (the head only moves
 *   forward); one that is merely too old for this caller is kept for others.
 * - `invalidateEntity(id)` drops every projection of one primary record, and
 *   cancels its loads in flight, in O(k + loads in flight) through a secondary
 *   index instead of an O(n) scan.
 * - `sweepExpired(maxScan)` reclaims expired entries in bounded steps, so a
 *   periodic sweep never stalls the event loop on a large cache.
 * - `inspect()` runs `StaleProjectionDetector` over the live entries, and
 *   `evictStale(auth, …)` evicts what it flags: an operator action gated on
 *   `admin:recovery`, like `clear`.
 * - a ledger sequence must be a non-negative safe integer. `NaN` used to be
 *   stored, and since `x < NaN` is false it disabled the stale-write guard
 *   for that key.
 *
 * Complexity: `get`, `set`, `invalidate` and `getOrLoad` are O(1) — a `Map`
 * keeps insertion order, so re-inserting on access makes its first key the
 * least recently used. `invalidateEntity` is O(k + loads in flight),
 * `sweepExpired(m)` is O(m), and `invalidateWhere`, `clear`, `snapshot`,
 * `inspect` and `evictStale` are O(n). Space is O(maxEntries + loads in flight).
 */

import { hasPermission } from "@/core/auth/types";
import type { AuthContext } from "@/core/auth/middleware";
import { err, ok, type Result } from "@/core/result/result";
import { emitTelemetry, newCorrelationId } from "@/core/telemetry/telemetry";
import { StaleProjectionDetector } from "./stale-detector";
import type { CacheEntry, InspectionContext, StaleInspectionReport } from "./types";

/**
 * `cache_stale` is only returned to a caller that passed `CacheReadOptions`,
 * so existing callers see exactly the two codes they always did.
 */
export type CacheReadErrorCode = "cache_miss" | "cache_expired" | "cache_stale";
export type CacheWriteErrorCode = "cache_stale_write";
export type CacheFlushErrorCode = "cache_unauthorized";

export interface BoundedCacheOptions {
  /** Upper bound on stored entries; the least recently used one is evicted. */
  readonly maxEntries: number;
  /** Default time-to-live for an entry, in milliseconds. */
  readonly ttlMs: number;
  /** Stamped on every entry for `StaleProjectionDetector`. Defaults to 1. */
  readonly schemaVersion?: number;
  /** Telemetry label, e.g. `horizon.accounts`. */
  readonly name?: string;
  /** Injected clock. Defaults to the wall clock. */
  readonly now?: () => number;
}

export interface CacheWriteOptions {
  /** Overrides the cache-wide TTL for this entry. */
  readonly ttlMs?: number;
  /** Ledger the value was read at. Writes may not move it backwards. */
  readonly ledgerSequence?: number;
  /** Primary record this value projects, for orphan detection and `invalidateEntity`. */
  readonly sourceEntityId?: string;
}

/** Freshness a caller requires on top of the TTL (#411). */
export interface CacheReadOptions {
  /**
   * The ledger head the caller knows of. An entry read at an older ledger is
   * evicted and reported as `cache_stale`; an entry with no ledger sequence
   * cannot prove it is current, so it is `cache_stale` but kept.
   */
  readonly minLedgerSequence?: number;
  /** A tighter age limit than the TTL for this read; a too-old entry is kept for other readers. */
  readonly maxAgeMs?: number;
}

export type CacheLoadOptions = CacheWriteOptions & CacheReadOptions;

export interface SweepResult {
  readonly examined: number;
  readonly removed: number;
}

export interface StaleEviction {
  readonly report: StaleInspectionReport;
  readonly evicted: readonly string[];
}

/** Context for `inspect`; the schema version and clock default to the cache's own. */
export type CacheInspectionContext = Omit<InspectionContext, "currentSchemaVersion" | "now"> & {
  readonly currentSchemaVersion?: number;
};

export interface CacheStats {
  readonly size: number;
  readonly hits: number;
  readonly misses: number;
  readonly evictions: number;
  readonly invalidations: number;
  /** Entries dropped because their TTL ran out (on read or by `sweepExpired`). */
  readonly expirations: number;
  /** Reads refused as `cache_stale` (#411). */
  readonly staleReads: number;
}

export type CacheLoader<V, C extends string> = () => Promise<Result<V, C>>;

export interface BoundedCache<V> {
  get(key: string, read?: CacheReadOptions): Result<V, CacheReadErrorCode>;
  set(key: string, value: V, options?: CacheWriteOptions): Result<true, CacheWriteErrorCode>;
  /**
   * Returns the cached value or runs `load` once for every concurrent caller.
   * A completed load that cannot meet this caller's read bounds returns `cache_stale_write`.
   * A failed load is never cached, so the next call retries it. A load that
   * was invalidated while in flight returns its value but does not store it.
   */
  getOrLoad<C extends string>(
    key: string,
    load: CacheLoader<V, C>,
    options?: CacheLoadOptions
  ): Promise<Result<V, C | CacheWriteErrorCode>>;
  /** Drops one key and any load in flight for it. */
  invalidate(key: string): boolean;
  /** Drops every key the predicate selects and returns how many went. */
  invalidateWhere(predicate: (entry: CacheEntry<V>) => boolean): number;
  /** Drops every entry projecting `sourceEntityId`, and every load in flight for it. */
  invalidateEntity(sourceEntityId: string): number;
  /**
   * Examines at most `maxScan` entries, least recently used first, and drops
   * the expired ones. Call it on a timer to reclaim memory in bounded steps.
   */
  sweepExpired(maxScan?: number): SweepResult;
  /** Read-only stale report over the live entries (no eviction). */
  inspect(context?: CacheInspectionContext): StaleInspectionReport;
  /** Evicts every entry `inspect` flags. An operator action: requires `admin:recovery`. */
  evictStale(auth: AuthContext, reason: string, context?: CacheInspectionContext): Result<StaleEviction, CacheFlushErrorCode>;
  /** Drops everything. An operator action: requires `admin:recovery`. */
  clear(auth: AuthContext, reason: string): Result<number, CacheFlushErrorCode>;
  /** Live entries in the shape `StaleProjectionDetector.inspect` reads. */
  snapshot(): CacheEntry<V>[];
  stats(): CacheStats;
}

interface StoredEntry<V> {
  readonly value: V;
  readonly cachedAt: number;
  readonly ttlMs: number;
  readonly version: number;
  readonly ledgerSequence?: number;
  readonly sourceEntityId?: string;
}

function requirePositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer, received ${value}`);
  }
}

/** Ledger sequences (uint32 on the network) and age limits: anything else cannot be compared safely. */
function requireNonNegativeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer, received ${value}`);
  }
}

/** Default and ceiling for one `sweepExpired` call. */
export const DEFAULT_SWEEP_SCAN = 100;

export function createBoundedCache<V>(options: BoundedCacheOptions): BoundedCache<V> {
  const { maxEntries, ttlMs, schemaVersion = 1, name = "cache" } = options;
  requirePositiveInteger("maxEntries", maxEntries);
  requirePositiveInteger("ttlMs", ttlMs);
  requirePositiveInteger("schemaVersion", schemaVersion);
  const now = options.now ?? (() => Date.now());

  const entries = new Map<string, StoredEntry<V>>();
  // The promise identity is the load's token: a load may only store its value
  // while it is still the registered load for its key.
  const inflight = new Map<string, Promise<Result<V, string>>>();
  // Secondary index for `invalidateEntity`: source entity id → keys projecting it.
  const bySource = new Map<string, Set<string>>();
  // The entity a load in flight will project, so `invalidateEntity` can cancel
  // a load whose key has no stored entry yet. Size ≤ loads in flight.
  const inflightSource = new Map<string, { readonly run: Promise<unknown>; readonly id: string }>();
  let hits = 0;
  let misses = 0;
  let evictions = 0;
  let invalidations = 0;
  let expirations = 0;
  let staleReads = 0;

  /** Removes a stored entry and its index link. Every removal goes through here. */
  function drop(key: string): boolean {
    const entry = entries.get(key);
    if (!entry) return false;
    entries.delete(key);
    if (entry.sourceEntityId !== undefined) {
      const keys = bySource.get(entry.sourceEntityId);
      keys?.delete(key);
      if (keys?.size === 0) bySource.delete(entry.sourceEntityId);
    }
    return true;
  }

  function store(key: string, entry: StoredEntry<V>): void {
    drop(key);
    entries.set(key, entry);
    if (entry.sourceEntityId !== undefined) {
      let keys = bySource.get(entry.sourceEntityId);
      if (!keys) bySource.set(entry.sourceEntityId, (keys = new Set()));
      keys.add(key);
    }
  }

  /** Same boundary as `StaleProjectionDetector`: stale once age exceeds the TTL. */
  function isExpired(entry: StoredEntry<V>, at: number): boolean {
    return at - entry.cachedAt > entry.ttlMs;
  }

  function toCacheEntry(key: string, entry: StoredEntry<V>): CacheEntry<V> {
    return {
      key,
      value: entry.value,
      cachedAt: entry.cachedAt,
      ttlMs: entry.ttlMs,
      version: entry.version,
      ledgerSequence: entry.ledgerSequence,
      sourceEntityId: entry.sourceEntityId
    };
  }

  function get(key: string, read: CacheReadOptions = {}): Result<V, CacheReadErrorCode> {
    if (read.minLedgerSequence !== undefined) requireNonNegativeInteger("minLedgerSequence", read.minLedgerSequence);
    if (read.maxAgeMs !== undefined) requireNonNegativeInteger("maxAgeMs", read.maxAgeMs);
    const entry = entries.get(key);
    if (!entry) {
      misses += 1;
      return err("cache_miss");
    }
    const at = now();
    if (isExpired(entry, at)) {
      drop(key);
      misses += 1;
      expirations += 1;
      return err("cache_expired");
    }
    if (read.minLedgerSequence !== undefined) {
      if (entry.ledgerSequence === undefined) {
        misses += 1;
        staleReads += 1;
        return err("cache_stale");
      }
      if (entry.ledgerSequence < read.minLedgerSequence) {
        // Behind a head the caller has seen: stale for every reader from now on.
        drop(key);
        inflight.delete(key);
        misses += 1;
        staleReads += 1;
        invalidations += 1;
        return err("cache_stale");
      }
    }
    if (read.maxAgeMs !== undefined && at - entry.cachedAt > read.maxAgeMs) {
      misses += 1;
      staleReads += 1;
      return err("cache_stale");
    }
    // Re-insert so the Map's first key stays the least recently used.
    entries.delete(key);
    entries.set(key, entry);
    hits += 1;
    return ok(entry.value);
  }

  function set(key: string, value: V, write: CacheWriteOptions = {}): Result<true, CacheWriteErrorCode> {
    // A NaN TTL would never expire (`age > NaN` is false), so it is refused like a bad bound.
    if (write.ttlMs !== undefined) requirePositiveInteger("ttlMs", write.ttlMs);
    // Likewise a NaN ledger sequence would disable the stale-write guard below for this key (#359).
    if (write.ledgerSequence !== undefined) requireNonNegativeInteger("ledgerSequence", write.ledgerSequence);
    const at = now();
    const current = entries.get(key);
    if (
      current &&
      !isExpired(current, at) &&
      current.ledgerSequence !== undefined &&
      write.ledgerSequence !== undefined &&
      write.ledgerSequence < current.ledgerSequence
    ) {
      return err("cache_stale_write");
    }

    store(key, {
      value,
      cachedAt: at,
      ttlMs: write.ttlMs ?? ttlMs,
      version: schemaVersion,
      ledgerSequence: write.ledgerSequence,
      sourceEntityId: write.sourceEntityId
    });
    if (entries.size > maxEntries) {
      drop(entries.keys().next().value as string);
      evictions += 1;
    }
    return ok(true);
  }

  async function getOrLoad<C extends string>(
    key: string,
    load: CacheLoader<V, C>,
    options: CacheLoadOptions = {}
  ): Promise<Result<V, C | CacheWriteErrorCode>> {
    const { minLedgerSequence, maxAgeMs, ...write } = options;
    const cached = get(key, { minLedgerSequence, maxAgeMs });
    if (cached.ok) return cached;

    const ensureFresh = (loaded: Result<V, C | CacheWriteErrorCode>): Result<V, C | CacheWriteErrorCode> => {
      if (!loaded.ok || (minLedgerSequence === undefined && maxAgeMs === undefined)) return loaded;
      // A shared load may have started under weaker bounds than this caller requires.
      const fresh = get(key, { minLedgerSequence, maxAgeMs });
      return fresh.ok ? fresh : err("cache_stale_write");
    };
    const pending = inflight.get(key) as Promise<Result<V, C | CacheWriteErrorCode>> | undefined;
    if (pending) return pending.then(ensureFresh);

    // `load` starts on the next microtask, so `run` is always assigned before
    // either callback compares against it — even when `load` throws at once.
    const run: Promise<Result<V, C | CacheWriteErrorCode>> = Promise.resolve()
      .then(load)
      .then((loaded) => {
        if (!loaded.ok || inflight.get(key) !== run) return loaded;
        const stored = set(key, loaded.value, write);
        return stored.ok ? loaded : stored;
      })
      .finally(() => {
        if (inflight.get(key) === run) inflight.delete(key);
        if (inflightSource.get(key)?.run === run) inflightSource.delete(key);
      });
    inflight.set(key, run);
    if (write.sourceEntityId !== undefined) inflightSource.set(key, { run, id: write.sourceEntityId });
    return run.then(ensureFresh);
  }

  function invalidate(key: string): boolean {
    inflight.delete(key);
    const removed = drop(key);
    if (removed) invalidations += 1;
    return removed;
  }

  function invalidateWhere(predicate: (entry: CacheEntry<V>) => boolean): number {
    let removed = 0;
    // Deleting the current key while iterating a Map is safe; snapshot keys anyway
    // so a predicate that touches the cache cannot change what is visited.
    for (const [key, entry] of Array.from(entries)) {
      if (predicate(toCacheEntry(key, entry))) {
        drop(key);
        inflight.delete(key);
        removed += 1;
      }
    }
    invalidations += removed;
    return removed;
  }

  function invalidateEntity(sourceEntityId: string): number {
    for (const [key, link] of Array.from(inflightSource)) {
      if (link.id !== sourceEntityId) continue;
      if (inflight.get(key) === link.run) inflight.delete(key);
      inflightSource.delete(key);
    }
    const keys = bySource.get(sourceEntityId);
    if (!keys) return 0;
    let removed = 0;
    for (const key of Array.from(keys)) {
      inflight.delete(key);
      if (drop(key)) removed += 1;
    }
    invalidations += removed;
    return removed;
  }

  function sweepExpired(maxScan: number = DEFAULT_SWEEP_SCAN): SweepResult {
    requirePositiveInteger("maxScan", maxScan);
    const at = now();
    let examined = 0;
    const expired: string[] = [];
    // The Map's first keys are the least recently used, the likeliest to have
    // expired. Stop after `maxScan` so the cost is O(maxScan), not O(n).
    for (const [key, entry] of entries) {
      if (examined >= maxScan) break;
      examined += 1;
      if (isExpired(entry, at)) expired.push(key);
    }
    for (const key of expired) drop(key);
    expirations += expired.length;
    return { examined, removed: expired.length };
  }

  function inspect(context: CacheInspectionContext = {}): StaleInspectionReport {
    return StaleProjectionDetector.inspect(snapshot(), [], {
      ...context,
      currentSchemaVersion: context.currentSchemaVersion ?? schemaVersion,
      now: now()
    });
  }

  function evictStale(
    auth: AuthContext,
    reason: string,
    context: CacheInspectionContext = {}
  ): Result<StaleEviction, CacheFlushErrorCode> {
    const correlationId = newCorrelationId();
    if (!hasPermission(auth.role, "admin:recovery")) {
      emitTelemetry({
        op: "cache.stale_evicted",
        actorType: "user",
        result: "failure",
        correlationId,
        errorCode: "cache_unauthorized",
        payload: { cache: name, role: auth.role }
      });
      return err("cache_unauthorized");
    }

    const report = inspect(context);
    const evicted: string[] = [];
    for (const finding of report.findings) {
      inflight.delete(finding.targetKey);
      if (drop(finding.targetKey)) evicted.push(finding.targetKey);
    }
    invalidations += evicted.length;
    emitTelemetry({
      op: "cache.stale_evicted",
      actorType: "user",
      result: "success",
      correlationId,
      payload: {
        cache: name,
        role: auth.role,
        reason,
        scanned: report.totalCachesScanned,
        evicted: evicted.length,
        reasons: Array.from(new Set(report.findings.map((finding) => finding.staleReason)))
      }
    });
    return ok({ report, evicted });
  }

  function clear(auth: AuthContext, reason: string): Result<number, CacheFlushErrorCode> {
    const correlationId = newCorrelationId();
    if (!hasPermission(auth.role, "admin:recovery")) {
      emitTelemetry({
        op: "cache.flushed",
        actorType: "user",
        result: "failure",
        correlationId,
        errorCode: "cache_unauthorized",
        payload: { cache: name, role: auth.role }
      });
      return err("cache_unauthorized");
    }

    const removed = entries.size;
    entries.clear();
    bySource.clear();
    inflight.clear();
    inflightSource.clear();
    invalidations += removed;
    emitTelemetry({
      op: "cache.flushed",
      actorType: "user",
      result: "success",
      correlationId,
      payload: { cache: name, role: auth.role, removed, reason }
    });
    return ok(removed);
  }

  function snapshot(): CacheEntry<V>[] {
    return Array.from(entries, ([key, entry]) => toCacheEntry(key, entry));
  }

  function stats(): CacheStats {
    return { size: entries.size, hits, misses, evictions, invalidations, expirations, staleReads };
  }

  return { get, set, getOrLoad, invalidate, invalidateWhere, invalidateEntity, sweepExpired, inspect, evictStale, clear, snapshot, stats };
}
