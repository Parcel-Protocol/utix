# Stale Cache and Stale Index Detection with Automated Repair (#236)

## Overview
Utix maintains read-heavy projections, memoized Horizon client responses, decoded transaction caches, and lookup indices to provide fast query responses. Over time or after network disconnects, projections can become stale due to TTL expiry, schema migrations, ledger sequence advancement, or missing target records.

The **Stale Projection Detector** (`core/cache/stale-detector.ts`) identifies, scopes, and provides automated repair recommendations with operator-visible telemetry and audit logging.

---

## Staleness Classification

| Reason | Description | Recommended Action | Severity |
| :--- | :--- | :--- | :--- |
| `ttl_expired` | Entry age exceeds configured TTL window | Evict | Info / Warning |
| `version_mismatch` | Serialization schema is older than system schema | Resync / Reindex | Warning |
| `ledger_drift` | Cached state sequence is behind authoritative ledger head | Resync | Warning / Critical |
| `orphan_reference` | Cache entry points to deleted or absent root entity | Evict | Warning |
| `index_inconsistency` | Index pointer targets absent record | Reindex | Critical |

---

## Operational Edge Cases

1. **Horizon Ledger Sequence Ingestion Lag**:
   - During high network activity, Horizon nodes may temporarily trail Stellar Core by 1-2 ledgers.
   - The detector incorporates a configurable tolerance window (`maxToleratedDriftLedgers`, default 5 ledgers) to prevent false-positive churn.

2. **Concurrent Mutation during Reindex**:
   - If an index is being rebuilt while a transaction mutation occurs, reindex operations must use version checks or idempotency keys to avoid overwriting newer mutations.

3. **High-Cardinality Cache Partition Eviction**:
   - If thousands of keys expire simultaneously, bulk eviction is partitioned to prevent event-loop latency spikes.

---

## Failure Modes & Mitigations

| Failure Mode | Impact | Mitigation |
| :--- | :--- | :--- |
| **Repair Action Failure** | Network error during resync | Failed repairs are marked `success: false` and queued for background retry |
| **Cascading Eviction Storm** | Evicting all keys simultaneously causes backend overload | Evictions are staged with rate-limiting; fallback stale serve during burst |
| **Index Pointer Deadlock** | Corrupted pointer cannot be resolved | Safe fallback to primary table lookup when index pointer is flagged stale |

---

## Rollback & Recovery Steps

1. **Reverting an Erroneous Eviction**:
   - Cache entries are projections of primary state (Horizon ledgers, accounts, transactions).
   - Re-querying the primary source automatically populates a fresh cache entry.

2. **Index Rebuild Recovery**:
   - If an automated index rebuild was interrupted, run the reindex task with the partition key or full rebuild flag.
   - All repairs log evidence under `projection.repaired` in the audit log for inspection.

---

## Bounded Cache with Explicit Invalidation (#270)

`core/cache/bounded-cache.ts` is the cache the detector above inspects. It is
an LRU bounded by `maxEntries`, with a TTL per entry.

```ts
const cache = createBoundedCache<AccountView>({ maxEntries: 500, ttlMs: 30_000, name: "accounts" });
const view = await cache.getOrLoad(`account:${id}`, () => loadAccount(id), { ledgerSequence });
cache.invalidate(`account:${id}`);                          // one key, O(1)
cache.invalidateWhere((entry) => entry.sourceEntityId === id); // a scope, O(n)
cache.clear({ role: "maintainer" }, "schema rollback");     // everything, authorised
StaleProjectionDetector.inspect(cache.snapshot(), [], context);
```

| Operation | Time | Notes |
| :--- | :--- | :--- |
| `get` / `set` / `invalidate` / `getOrLoad` | O(1) | `Map` insertion order is the LRU order |
| `invalidateWhere` / `clear` / `snapshot` | O(n) | n ≤ `maxEntries` |
| Space | O(maxEntries + loads in flight) | |

| Code | Meaning | Caller action |
| :--- | :--- | :--- |
| `cache_miss` | Key absent or evicted | Load from the source |
| `cache_expired` | Age exceeded the TTL; the entry was dropped | Load from the source |
| `cache_stale_write` | Write carried an older `ledgerSequence` than the live entry | Keep the newer entry; nothing to do |
| `cache_unauthorized` | `clear` called without `admin:recovery` | Ask a maintainer |

### Operational edge cases

1. **Concurrent misses** for one key share one load (`getOrLoad`), so a burst of
   requests for the same account is one Horizon request, not N.
2. **Failed loads are never cached.** The next call retries the source. A loader
   that throws releases its in-flight slot before the rejection reaches the caller.
3. **Invalidation during a load**: the in-flight load still answers its caller
   but does not store its value, so a value read before the invalidation cannot
   repopulate the cache after it.
4. **Out-of-order responses**: a write whose `ledgerSequence` is older than the
   live entry's is refused (`cache_stale_write`). Once that entry expires, any
   ledger is accepted again, so a testnet reset (which restarts sequences) heals
   itself within one TTL. Flush with `clear` to heal it immediately.
5. **Clock skew**: age uses the injected clock only. Backwards clock jumps make
   entries look younger, never older, so they cannot cause premature eviction.

### Rollback and recovery

- Every entry is a projection of Horizon/RPC state, so any eviction or flush is
  safe: the next read reloads from the source.
- After changing a value's shape, raise `schemaVersion`. The cache is in-memory,
  so a deploy starts it empty. When snapshots are compared across instances, the
  detector reports entries stamped with the older version as `version_mismatch`.
- Rolling the module back is safe because nothing persists. The cache lives in
  memory only, and no existing export or contract changed. The module only adds
  new exports to `core/cache/index.ts`.

## Bounded Invalidation and Read-Time Stale Detection (#411)

The #270 cache already caps its size and refuses out-of-order writes. #411
closes the remaining gaps: a reader that knows the ledger head could still be
served a projection from before it, invalidating one account's projections
meant an O(n) scan, and expired entries that were never read again stayed in
memory until LRU eviction pushed them out.

```ts
// Read-time freshness: never serve a projection from before the head you have seen.
cache.get(`account:${id}`, { minLedgerSequence: head });  // cache_stale if behind, and evicted
cache.get("fee_stats", { maxAgeMs: 5_000 });              // cache_stale if older, kept for others
await cache.getOrLoad(key, load, { minLedgerSequence: head, ledgerSequence: head });

// Bounded invalidation.
cache.invalidateEntity(accountId);  // every projection of one record, O(k + loads in flight)
cache.sweepExpired(100);            // examines ≤ 100 entries, LRU first; call it on a timer

// Detection and authorised repair.
cache.inspect({ authoritativeLedgerSequence: head });           // read-only StaleInspectionReport
cache.evictStale({ role: "maintainer" }, "head moved", { authoritativeLedgerSequence: head });
```

| Operation | Time | Notes |
| :--- | :--- | :--- |
| `get(key, read)` | O(1) | Same cost as before; the checks are comparisons |
| `invalidateEntity` | O(k + loads in flight) | Secondary index `sourceEntityId → keys` |
| `sweepExpired(m)` | O(m) | m ≤ the caller's bound (default `DEFAULT_SWEEP_SCAN` = 100) |
| `inspect` / `evictStale` | O(n) | n ≤ `maxEntries` |
| Space | O(maxEntries + loads in flight) | The entity index holds one link per stored key |

| Code / stat | Meaning | Caller action |
| :--- | :--- | :--- |
| `cache_stale` | Entry behind `minLedgerSequence` (evicted), without a ledger sequence, or older than `maxAgeMs` (kept) | Load from the source |
| `cache_unauthorized` | `evictStale` called without `admin:recovery` | Ask a maintainer |
| `stats().staleReads` | Reads refused as `cache_stale` | Alert if it climbs: a projection is lagging |
| `stats().expirations` | Entries dropped for TTL, on read or by sweep | — |

`cache.stale_evicted` telemetry records every `evictStale`, allowed or refused,
with the cache name, role, reason and the stale reasons found.

### Operational edge cases

1. **Entries without a ledger sequence** (TOML files, fee stats) cannot prove
   they are current, so a head-aware read gets `cache_stale`, but the entry is
   kept for readers that did not ask.
2. **Head regressions**: only an entry *behind* the head is evicted. A caller
   passing a lower head than before simply accepts more entries.
3. **Invalidation races**: `invalidateEntity` also cancels loads in flight for
   that entity, even when nothing is stored for the key yet, so a response read
   before the invalidation can never be stored after it.
4. **Sweep coverage**: `sweepExpired` looks at the least recently used entries
   first. Expired entries further up the list are found by later sweeps, read
   expiry, or LRU eviction; memory stays bounded by `maxEntries` regardless.
5. **Invalid input** fails fast with `RangeError`: a ledger sequence or age that
   is not a non-negative safe integer, or a sweep bound below 1. A `NaN` ledger
   sequence used to be stored and silently disabled the stale-write guard for
   that key (found by the #359 property tests).
6. **Unreadable timestamps**: the detector now reports an entry whose `cachedAt`
   cannot be read as `ttl_expired` (its age is unknown) instead of passing it as
   fresh forever.

### Rollback and recovery

- Every new path only removes projections, so the worst case of a wrong
  eviction is one extra Horizon read. `evictStale` can be rerun safely: a second
  pass finds nothing to do.
- Contracts are preserved. `get(key)` with no options returns exactly the codes
  it did before, `getOrLoad`'s third argument still accepts `CacheWriteOptions`,
  and `stats()` only gains fields. The one tightening is that `set` now refuses
  an invalid `ledgerSequence`. No caller in the repository passes one, and such a
  write could only ever disable the guard. No migration is needed.
- To roll back, revert `core/cache/bounded-cache.ts`. The cache lives in memory,
  so a deploy starts it empty either way.
