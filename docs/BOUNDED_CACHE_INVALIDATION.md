# Bounded Cache Invalidation & Stale Detection (#455)

## Overview

The `BoundedCache` module provides memory-bounded caching with deterministic LRU eviction, read-time stale detection based on ledger sequence and TTL, secondary-indexed entity invalidation, and gated maintenance operations.

## Acceptance Criteria & Paths

### 1. Normal Path
- Stores projections up to `maxEntries`; evicts the least recently used entry when capacity is reached.
- Returns cached values when ledger sequence is at or ahead of reader's `minLedgerSequence`.

### 2. Failure Path
- `cache_miss`: Returned when key is not present.
- `cache_expired`: Returned when current timestamp exceeds entry TTL.
- `cache_stale`: Returned when reader requests a ledger sequence ahead of the cached projection.
- `cache_stale_write`: Rejects out-of-order writes where incoming ledger sequence is older than existing entry.

### 3. Retry Path
- `getOrLoad(key, loader)` executes the loader and does NOT cache errors.
- Flaky or transient failures can be retried immediately without poisoning the cache.

### 4. Authorization & Entity Invalidation Path
- Secondary index on `sourceEntityId` enables `invalidateEntity(id)` in O(k) time to evict all projections of a modified entity.
- Maintenance actions (`evictStale`, `clear`) require `admin:recovery` authorization; unauthorized callers receive `cache_unauthorized`.

## Edge Cases and Recovery

- **Ledger Sequence Invariant**: Sequences must be non-negative safe integers. `NaN` values are rejected to prevent disabling the stale-write guard.
- **Concurrent Readers**: In-flight deduplication ensures a slow loader is only invoked once, and invalidating the entity cancels matching in-flight loads.
