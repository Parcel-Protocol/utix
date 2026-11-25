# Deterministic Replay for Multi-Actor Mutations (#423)

## Overview

Utix relies on append-only event logs to rebuild read-model projections without rewriting history or blocking live queries. While single-actor events (such as basic balance deposits) follow simple monotonic updates, **multi-actor mutations** involve multi-party transfers, atomic fee splits, and state transitions spanning multiple participants:

1. **Event Organizer**: Issues primary tickets and collects primary proceeds and secondary royalties.
2. **Buyer & Seller**: Secondary transfer parties where ticket ownership swaps and value is debited/credited.
3. **Protocol Treasury**: Receives protocol fees on secondary trades.
4. **Gatekeeper / Verifier**: Redemptions and admission checks.

`core/replay/multi-actor-mutations.ts` implements this multi-actor projection model, while `core/replay/__tests__/multi-actor-mutations.deterministic.test.ts` and `scripts/verify-issue-423.mjs` provide comprehensive deterministic verification.

---

## Domain Model & Multi-Actor Events

### 1. State Structure

```ts
export interface MultiActorMutationState {
  readonly accounts: Readonly<Record<string, MultiActorAccount>>;
  readonly tickets: Readonly<Record<string, MultiActorTicket>>;
  readonly totalProtocolFeesStroops: number;
  readonly totalOrganizerFeesStroops: number;
  readonly transfersCompleted: number;
  readonly redemptionsCompleted: number;
  readonly appliedEventIds: readonly string[];
  readonly lastSequence: number;
}
```

### 2. Events & Conservation Invariants

- **`account.created` (v1)**: Sets up an actor account with initial balance and role (`organizer`, `buyer`, `seller`, `treasury`).
- **`ticket.minted` (v1)**: Primary sale from organizer to buyer; checks buyer solvency and credits organizer.
- **`ticket.transferred` (v2)**: Atomic secondary settlement across four actors:
  $$\text{Price} = \text{Seller Proceeds} + \text{Organizer Fee} + \text{Protocol Fee}$$
  - Buyer balance is debited by `priceStroops`.
  - Seller balance is credited by `sellerProceedsStroops`.
  - Organizer balance is credited by `organizerFeeStroops`.
  - Treasury balance is credited by `protocolFeeStroops`.
  - Ticket `ownerAddress` atomically moves to `buyer`.
- **`ticket.redeemed` (v1)**: Marks ticket as redeemed by current authorized holder.

---

## Schema Evolution & Upcasting

Legacy events (`ticket.transferred` v1) carried decimal strings and basic two-party fees without explicit protocol/organizer splits.

`multiActorUpcasters` lifts legacy v1 events into the canonical v2 schema on read:
```ts
{
  type: "ticket.transferred",
  fromVersion: 1,
  upcast: (payload) => {
    // Computes exact stroop integers and derives 50/50 protocol vs organizer fee split
  }
}
```

---

## Execution Paths Covered

### 1. Normal Path
- Multi-batch deterministic replay (`batchSize: 3`) across interleaved multi-actor event sequences.
- On-the-fly upcasting of legacy v1 events to v2.
- Blue/green staging in slot `multi-actor-settlement@v1`.
- State validation verifies zero invariant violations.
- Atomic promotion (`store.setActive`) sets active version pointer to 1.
- Final state exactly matches the pure serial fold `expectedMultiActorState(...)`.
- Point-in-time replay (`untilSequence`) stops cleanly at specified log offset.

### 2. Failure Paths & Poison Policies
- **Poison Event (`halt`)**: Invalid mutations (e.g. insolvent buyer, invalid fee split, negative price) halt replay without writing to or corrupting the active live slot.
- **Poison Event (`skip`)**: Under `poisonPolicy: "skip"` with `maxSkipped`, isolated bad events advance the checkpoint, record the event in `report.skipped`, and allow subsequent valid mutations to complete.
- **Bound Exceeded (`too_many_skipped`)**: When skipped events exceed `maxSkipped`, replay terminates with `too_many_skipped`.
- **Validation Failure (`validation_failed`)**: If `validate(state)` discovers invariant breaches, promotion is refused, leaving the slot in `failed` status for investigation.
- **Sequence Integrity (`sequence_out_of_order`)**: Replay strictly rejects non-increasing event sequences.

### 3. Retry Path with Exponential Backoff
- Transient event source read errors are retried up to `maxRetries` (default 3).
- Delays follow deterministic exponential backoff ($delay \times 2^n$) using an injected deterministic clock (`createDeterministicClock`).
- Sleep intervals and retry attempts are deterministically recorded without relying on wall-clock time.
- If all retries fail, terminates cleanly with `source_unavailable`.

### 4. Authorization & Auditing
- Replay is a sensitive maintainer operation requiring `admin:replay` permission (`REPLAY_PERMISSION`).
- Unauthorized callers (`viewer`, unprivileged user, unauthorized service) are rejected immediately with `replay_unauthorized`.
- Every attempt emits an audit trail entry (`projection.replayed`) logging actor ID, role, scope, outcome (`allowed` vs `denied`), and error code.

### 5. Rollback, Catch-Up & Lock Concurrency
- **Atomic Rollback**: If a newly promoted version (e.g. v2) needs rollback, `rollbackProjection` swaps the active pointer back to `previousVersion` (v1) instantly.
- **Live Catch-Up (`mode: "resume"`)**: Replays newer events arriving after rollback starting from checkpoint, safely updating the slot only after full batch validation.
- **Lock Concurrency**: A per-projection lock (`store.acquireLock`) blocks colliding replay workers (`replay_in_progress`). If a process halts past `lockTtlMs`, the lock expires safely.

---

## Verification

To run the automated verification suite:

```bash
npm run verify:issues-423
```
or
```bash
node --loader ./scripts/loader.mjs scripts/verify-issue-423.mjs
```
