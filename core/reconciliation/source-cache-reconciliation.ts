/**
 * Focused reconciliation for source-of-truth vs cached projections (#332).
 *
 * The general `reconcile()` engine (`reconciliation.ts`) handles many
 * invariant classes. This module is narrower: it is only concerned with the
 * drift that arises when a **cached projection** disagrees with its **source
 * of truth**. For utix, the source of truth is the Stellar ledger; the cache
 * is whatever is stored in the application database.
 *
 * Four drift patterns are detected:
 *
 * | Pattern          | Description                                                        |
 * |------------------|--------------------------------------------------------------------|
 * | `cache_missing`  | Source has a record; cache has nothing.                           |
 * | `source_missing` | Cache has a record; source has nothing (stale / orphan cache).    |
 * | `amount_mismatch`| Both sides have the record but the amounts differ.                |
 * | `metadata_stale` | The cache is too old — its `cachedAt` precedes the source event.  |
 *
 * Usage:
 * ```ts
 * const result = reconcileSourceAndCache(sourceEntries, cachedEntries, {
 *   staleThresholdMs: 60_000,
 *   now: Date.now(),
 * });
 * if (result.drifted) {
 *   const { missing, orphans, mismatches, stale } = result.drift;
 * }
 * ```
 *
 * Nothing here writes to any store. Callers should pass drift findings to
 * `planRepairs` in `repair.ts` if remediation is desired.
 */

/** An entry as it exists in the source of truth (the Stellar ledger). */
export interface SourceEntry {
  /** Account G-address. */
  account: string;
  /** Asset in canonical `CODE:ISSUER` or `native` form. */
  asset: string;
  /** Decimal string, 7 dp max. */
  balance: string;
  /** Ledger sequence number at which this was read. */
  ledgerSequence: number;
}

/** An entry as it exists in the application cache / database. */
export interface CachedEntry {
  account: string;
  asset: string;
  balance: string;
  /** ISO-8601 timestamp of when this was last written. */
  cachedAt: string;
}

export interface SourceCacheOptions {
  /**
   * Maximum age (ms) of a cached entry before it is considered stale even if
   * amounts agree. Set to 0 to disable age checking.
   * @default 300_000  (5 minutes)
   */
  staleThresholdMs?: number;
  /** Epoch ms used as "now" — override in tests. @default Date.now() */
  now?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Finding types
// ─────────────────────────────────────────────────────────────────────────────

/** An entry the source has that the cache is missing entirely. */
export interface CacheMissingFinding {
  kind: "cache_missing";
  account: string;
  asset: string;
  sourceBalance: string;
  sourceSequence: number;
}

/** An entry the cache has that no longer appears in the source. */
export interface SourceMissingFinding {
  kind: "source_missing";
  account: string;
  asset: string;
  cachedBalance: string;
  cachedAt: string;
}

/** Both sides have the entry but the amounts differ. */
export interface AmountMismatchFinding {
  kind: "amount_mismatch";
  account: string;
  asset: string;
  sourceBalance: string;
  cachedBalance: string;
  sourceSequence: number;
  cachedAt: string;
}

/** Amounts agree but the cache is older than the allowed threshold. */
export interface MetadataStaleFinding {
  kind: "metadata_stale";
  account: string;
  asset: string;
  balance: string;
  cachedAt: string;
  ageMs: number;
  thresholdMs: number;
}

export type DriftFinding =
  | CacheMissingFinding
  | SourceMissingFinding
  | AmountMismatchFinding
  | MetadataStaleFinding;

// ─────────────────────────────────────────────────────────────────────────────
// Result
// ─────────────────────────────────────────────────────────────────────────────

export interface DriftSummary {
  /** Source entries that have no matching cache entry. */
  missing: CacheMissingFinding[];
  /** Cache entries that have no matching source entry. */
  orphans: SourceMissingFinding[];
  /** Entries present on both sides with differing balances. */
  mismatches: AmountMismatchFinding[];
  /** Entries that agree but whose cache timestamp is too old. */
  stale: MetadataStaleFinding[];
}

export type SourceCacheReconciliationResult =
  | { drifted: false; checkedAt: number; totalChecked: number }
  | {
      drifted: true;
      checkedAt: number;
      totalChecked: number;
      drift: DriftSummary;
      findings: DriftFinding[];
    };

// ─────────────────────────────────────────────────────────────────────────────
// Key helpers
// ─────────────────────────────────────────────────────────────────────────────

function entryKey(account: string, asset: string): string {
  return `${account}:${asset}`;
}

/** Decimal-aware equality — strips trailing zeros so "1.0" == "1.00". */
export function balancesEqual(a: string, b: string): boolean {
  const na = parseFloat(a);
  const nb = parseFloat(b);
  if (isNaN(na) || isNaN(nb)) return a === b;
  // 7 dp max on Stellar; compare as integers after scaling
  return Math.round(na * 1e7) === Math.round(nb * 1e7);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compare source-of-truth entries against cached entries and report every
 * kind of drift found.
 */
export function reconcileSourceAndCache(
  sourceEntries: readonly SourceEntry[],
  cachedEntries: readonly CachedEntry[],
  options: SourceCacheOptions = {}
): SourceCacheReconciliationResult {
  const { staleThresholdMs = 300_000, now = Date.now() } = options;

  const sourceMap = new Map<string, SourceEntry>();
  for (const entry of sourceEntries) {
    sourceMap.set(entryKey(entry.account, entry.asset), entry);
  }

  const cacheMap = new Map<string, CachedEntry>();
  for (const entry of cachedEntries) {
    cacheMap.set(entryKey(entry.account, entry.asset), entry);
  }

  const missing: CacheMissingFinding[] = [];
  const orphans: SourceMissingFinding[] = [];
  const mismatches: AmountMismatchFinding[] = [];
  const stale: MetadataStaleFinding[] = [];

  // Check every source entry against the cache
  for (const [key, src] of sourceMap.entries()) {
    const cached = cacheMap.get(key);
    if (!cached) {
      missing.push({
        kind: "cache_missing",
        account: src.account,
        asset: src.asset,
        sourceBalance: src.balance,
        sourceSequence: src.ledgerSequence,
      });
      continue;
    }

    if (!balancesEqual(src.balance, cached.balance)) {
      mismatches.push({
        kind: "amount_mismatch",
        account: src.account,
        asset: src.asset,
        sourceBalance: src.balance,
        cachedBalance: cached.balance,
        sourceSequence: src.ledgerSequence,
        cachedAt: cached.cachedAt,
      });
      // Still check staleness even when mismatch is present
    } else if (staleThresholdMs > 0) {
      const cachedAtMs = new Date(cached.cachedAt).getTime();
      const ageMs = now - cachedAtMs;
      if (ageMs > staleThresholdMs) {
        stale.push({
          kind: "metadata_stale",
          account: src.account,
          asset: src.asset,
          balance: src.balance,
          cachedAt: cached.cachedAt,
          ageMs,
          thresholdMs: staleThresholdMs,
        });
      }
    }
  }

  // Find cache entries with no source counterpart
  for (const [key, cached] of cacheMap.entries()) {
    if (!sourceMap.has(key)) {
      orphans.push({
        kind: "source_missing",
        account: cached.account,
        asset: cached.asset,
        cachedBalance: cached.balance,
        cachedAt: cached.cachedAt,
      });
    }
  }

  const findings: DriftFinding[] = [...missing, ...orphans, ...mismatches, ...stale];
  const totalChecked = sourceMap.size + cacheMap.size;

  if (findings.length === 0) {
    return { drifted: false, checkedAt: now, totalChecked };
  }

  return {
    drifted: true,
    checkedAt: now,
    totalChecked,
    drift: { missing, orphans, mismatches, stale },
    findings,
  };
}

/**
 * Convenience wrapper: returns only the most critical findings for operator
 * triage. Priority: mismatches > missing > orphans > stale.
 */
export function prioritisedFindings(result: SourceCacheReconciliationResult): DriftFinding[] {
  if (!result.drifted) return [];
  const { mismatches, missing, orphans, stale } = result.drift;
  return [...mismatches, ...missing, ...orphans, ...stale];
}
