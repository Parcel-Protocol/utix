import { describe, expect, it } from "vitest";
import {
  createMemoryQuotaStorage,
  createQuotaStore,
  isQuotaDenial,
  QUOTA_GLOBAL_SUBJECT,
  type QuotaPolicy,
  type QuotaReceipt,
  type QuotaStorage,
  type QuotaStore
} from "@/core/quota/quota";

/**
 * Concurrent reservation behaviour (issue #143).
 *
 * Quota correctness is a concurrency property: `consume` is a synchronous
 * read-modify-write over an injected `QuotaStorage`, and anything that
 * re-enters `consume` between that read and that write used to lose an update.
 * Two interleaved spends of one unit each were both approved while the counter
 * recorded a single unit, so the next request was approved too — more work
 * approved than the configured limit, which is exactly what a sequential test
 * cannot see.
 *
 * Every interleaving here is deterministic. A barrier storage re-enters the
 * store from inside `setItem`, before the outer write lands, so the two calls
 * are guaranteed to interleave at the vulnerable point. There is no sleep, no
 * timer and no reliance on scheduling: the same order happens on every run, and
 * a test that fails to interleave asserts on that fact rather than passing
 * vacuously.
 */
const START = Date.parse("2026-09-26T00:00:00.000Z");
const WINDOW = 60 * 60 * 1_000;
const MAINTAINER = { kind: "maintainer", id: "ada" } as const;

const TIGHT: QuotaPolicy = {
  operation: "tickets",
  resource: "compute",
  limit: 2,
  globalLimit: 2,
  windowMs: WINDOW
};

const PER_PRINCIPAL_ONLY: QuotaPolicy = {
  operation: "swaps",
  resource: "compute",
  limit: 2,
  globalLimit: 100,
  windowMs: WINDOW
};

/** A `QuotaStorage` that re-enters the store from inside its first write. */
function createBarrierStorage() {
  const inner = createMemoryQuotaStorage();
  const queue: Array<() => void> = [];
  let fired = 0;

  const storage: QuotaStorage = {
    getItem: (key) => inner.getItem(key),
    setItem: (key, value) => {
      // Fire before the outer value is written: this is the window in which the
      // outer call has decided but has not yet made its spend durable.
      const next = queue.shift();
      if (next) {
        fired += 1;
        next();
      }
      inner.setItem(key, value);
    },
    removeItem: (key) => inner.removeItem(key)
  };

  return {
    storage,
    /** Queue an action to run inside the next write. */
    interleave(action: () => void) {
      queue.push(action);
    },
    /** How many queued actions actually ran — so a test can prove it interleaved. */
    get fired() {
      return fired;
    },
    get pending() {
      return queue.length;
    }
  };
}

function makeStore(policy: QuotaPolicy, storage: QuotaStorage): QuotaStore {
  return createQuotaStore({ policies: [policy], now: () => START, storage });
}

/** Total a set of receipts claims to have spent. */
function totalCost(receipts: QuotaReceipt[]): number {
  return receipts.reduce((sum, receipt) => sum + receipt.cost, 0);
}

function usedBy(store: QuotaStore, subject: string): number {
  const usage = store.diagnose(MAINTAINER);
  if (!usage.ok) throw new Error("diagnose refused a maintainer actor");
  const row = usage.value.usage.find((entry) => entry.subject === subject);
  return row?.used ?? 0;
}

describe("quota reservations under interleaving", () => {
  it("charges both sides of an interleaved pair and refuses the next spend", () => {
    const barrier = createBarrierStorage();
    const store = makeStore(TIGHT, barrier.storage);

    let inner = null as ReturnType<QuotaStore["consume"]> | null;
    barrier.interleave(() => {
      inner = store.consume({
        operation: "tickets",
        principal: "account:GB",
        cost: 1,
        correlationId: "inner"
      });
    });

    const outer = store.consume({
      operation: "tickets",
      principal: "account:GA",
      cost: 1,
      correlationId: "outer"
    });

    // The barrier has to have fired, or this is a sequential test that proves
    // nothing about interleaving.
    expect(barrier.fired).toBe(1);
    expect(barrier.pending).toBe(0);
    expect(outer.ok).toBe(true);
    expect(inner?.ok).toBe(true);

    // Both spends are durable: the global counter is at its limit of 2.
    expect(usedBy(store, QUOTA_GLOBAL_SUBJECT)).toBe(2);
    expect(usedBy(store, "account:GA")).toBe(1);
    expect(usedBy(store, "account:GB")).toBe(1);

    // And the limit actually holds, which is the invariant the lost update broke.
    const next = store.consume({
      operation: "tickets",
      principal: "account:GC",
      cost: 1,
      correlationId: "next"
    });
    expect(next.ok).toBe(false);
    if (!next.ok) {
      expect(next.code).toBe("quota_exceeded");
      // Both principals are at their own limit, so the shared counter refuses and
      // the denial says which counter did it.
      expect(isQuotaDenial(next.detail)).toBe(true);
      expect(next.detail?.limitScope).toBe("global");
    }
    expect(usedBy(store, QUOTA_GLOBAL_SUBJECT)).toBe(2);
  });

  it("refuses an interleaved spend by the same principal once the limit is reserved", () => {
    const barrier = createBarrierStorage();
    const store = makeStore(PER_PRINCIPAL_ONLY, barrier.storage);

    // The outer call reserves the whole per-principal limit, so the nested call
    // for the same principal must be refused. Before reservations it read a
    // counter of zero and was approved, and its unit was then lost.
    let inner = null as ReturnType<QuotaStore["consume"]> | null;
    barrier.interleave(() => {
      inner = store.consume({
        operation: "swaps",
        principal: "account:GA",
        cost: 1,
        correlationId: "inner"
      });
    });

    const outer = store.consume({
      operation: "swaps",
      principal: "account:GA",
      cost: 2,
      correlationId: "outer"
    });

    expect(barrier.fired).toBe(1);
    expect(outer.ok).toBe(true);
    expect(inner?.ok).toBe(false);
    if (inner && !inner.ok) {
      expect(inner.code).toBe("quota_exceeded");
      expect(inner.detail?.limitScope).toBe("principal");
    }
    expect(usedBy(store, "account:GA")).toBe(2);
    expect(store.remaining("swaps", "account:GA")).toMatchObject({ ok: true, value: { remaining: 0 } });

    const third = store.consume({ operation: "swaps", principal: "account:GA", cost: 1 });
    expect(third.ok).toBe(false);
  });

  it("charges a multi-unit reservation in full when it interleaves", () => {
    const barrier = createBarrierStorage();
    const store = makeStore(TIGHT, barrier.storage);

    // The inner call costs the whole limit, so it must see the outer call's
    // pending unit and refuse rather than both claiming the same headroom.
    let inner = null as ReturnType<QuotaStore["consume"]> | null;
    barrier.interleave(() => {
      inner = store.consume({
        operation: "tickets",
        principal: "account:GB",
        cost: 2,
        correlationId: "inner"
      });
    });

    const outer = store.consume({
      operation: "tickets",
      principal: "account:GA",
      cost: 1,
      correlationId: "outer"
    });

    expect(barrier.fired).toBe(1);
    expect(outer.ok).toBe(true);
    expect(inner?.ok).toBe(false);
    // The refused cost is not charged: the shared counter holds only the outer
    // unit, not three.
    expect(usedBy(store, QUOTA_GLOBAL_SUBJECT)).toBe(1);
    expect(usedBy(store, "account:GB")).toBe(0);
  });

  it("does not let a refused interleaved spend disturb the counters", () => {
    const barrier = createBarrierStorage();
    const store = makeStore(TIGHT, barrier.storage);

    // The outer call spends the whole limit; the inner call then asks for more
    // and must be refused without disturbing what the outer reserved.
    let inner = null as ReturnType<QuotaStore["consume"]> | null;
    barrier.interleave(() => {
      inner = store.consume({
        operation: "tickets",
        principal: "account:GB",
        cost: 1,
        correlationId: "inner"
      });
    });

    const outer = store.consume({
      operation: "tickets",
      principal: "account:GA",
      cost: 2,
      correlationId: "outer"
    });

    expect(barrier.fired).toBe(1);
    expect(outer.ok).toBe(true);
    expect(inner?.ok).toBe(false);
    expect(usedBy(store, QUOTA_GLOBAL_SUBJECT)).toBe(2);
    expect(usedBy(store, "account:GB")).toBe(0);
    // The refusal is counted against the shared counter, which is what a
    // maintainer reads to see pressure on the global limit.
    expect(usedBy(store, QUOTA_GLOBAL_SUBJECT)).toBe(2);
    const diagnostics = store.diagnose(MAINTAINER);
    expect(diagnostics.ok).toBe(true);
    if (diagnostics.ok) {
      const shared = diagnostics.value.usage.find((row) => row.subject === QUOTA_GLOBAL_SUBJECT);
      expect(shared?.denied).toBeGreaterThan(0);
    }
  });

  it("accounts for every receipt of an interleaved pair", () => {
    const barrier = createBarrierStorage();
    const store = makeStore(TIGHT, barrier.storage);

    let inner = null as ReturnType<QuotaStore["consume"]> | null;
    barrier.interleave(() => {
      inner = store.consume({
        operation: "tickets",
        principal: "account:GB",
        cost: 1,
        correlationId: "inner"
      });
    });
    const outer = store.consume({
      operation: "tickets",
      principal: "account:GA",
      cost: 1,
      correlationId: "outer"
    });

    expect(barrier.fired).toBe(1);
    const receipts = [outer, inner]
      .filter((result): result is { ok: true; value: QuotaReceipt } => Boolean(result?.ok))
      .map((result) => result.value);

    expect(receipts).toHaveLength(2);
    // Receipts are the accounting record: their costs must add up to what the
    // counters recorded, or a caller that refunds them would refund the wrong
    // amount.
    expect(totalCost(receipts)).toBe(usedBy(store, QUOTA_GLOBAL_SUBJECT));
    expect(new Set(receipts.map((receipt) => receipt.correlationId)).size).toBe(2);
    for (const receipt of receipts) {
      expect(receipt.windowStart).toBe(receipts[0].windowStart);
      expect(typeof receipt.resetAt).toBe("string");
    }
  });

  it("rolls back a rejected downstream action and can be retried", () => {
    const barrier = createBarrierStorage();
    const store = makeStore(TIGHT, barrier.storage);

    // The "downstream action" is a second spend that interleaves with the
    // reservation the first one is holding. The first reserves the whole limit,
    // so the downstream attempt is refused against the limit this reservation is
    // holding — which is the case where a lost update would have let it through.
    let downstream = null as ReturnType<QuotaStore["consume"]> | null;
    barrier.interleave(() => {
      downstream = store.consume({
        operation: "tickets",
        principal: "account:GB",
        cost: 1,
        correlationId: "downstream"
      });
    });

    const reserved = store.consume({
      operation: "tickets",
      principal: "account:GA",
      cost: 2,
      correlationId: "reserved"
    });
    expect(reserved.ok).toBe(true);
    if (!reserved.ok) return;
    expect(barrier.fired).toBe(1);
    expect(downstream?.ok).toBe(false);
    expect(usedBy(store, QUOTA_GLOBAL_SUBJECT)).toBe(2);

    // The work behind the reservation never ran, so it is returned in full.
    store.refund(reserved.value);
    expect(usedBy(store, QUOTA_GLOBAL_SUBJECT)).toBe(0);
    expect(usedBy(store, "account:GA")).toBe(0);
    expect(store.remaining("tickets", "account:GA")).toMatchObject({ ok: true, value: { remaining: 2 } });

    // The refused attempt left no residue, so the retry now fits.
    const retry = store.consume({
      operation: "tickets",
      principal: "account:GB",
      cost: 1,
      correlationId: "retry"
    });
    expect(retry.ok).toBe(true);
    expect(usedBy(store, QUOTA_GLOBAL_SUBJECT)).toBe(1);
  });

  it("refunds an interleaved pair exactly once", () => {
    const barrier = createBarrierStorage();
    const store = makeStore(TIGHT, barrier.storage);

    let inner = null as ReturnType<QuotaStore["consume"]> | null;
    barrier.interleave(() => {
      inner = store.consume({
        operation: "tickets",
        principal: "account:GB",
        cost: 1,
        correlationId: "inner"
      });
    });
    const outer = store.consume({
      operation: "tickets",
      principal: "account:GA",
      cost: 1,
      correlationId: "outer"
    });

    expect(barrier.fired).toBe(1);
    expect(usedBy(store, QUOTA_GLOBAL_SUBJECT)).toBe(2);

    if (outer.ok) store.refund(outer.value);
    expect(usedBy(store, QUOTA_GLOBAL_SUBJECT)).toBe(1);

    // A repeated refund of the same receipt must not mint quota.
    if (outer.ok) store.refund(outer.value);
    expect(usedBy(store, QUOTA_GLOBAL_SUBJECT)).toBe(1);

    if (inner?.ok) store.refund(inner.value);
    expect(usedBy(store, QUOTA_GLOBAL_SUBJECT)).toBe(0);
    expect(store.remaining("tickets", "account:GA")).toMatchObject({ ok: true, value: { remaining: 2 } });
  });

  it("does not reserve anything for check()", () => {
    const barrier = createBarrierStorage();
    const store = makeStore(TIGHT, barrier.storage);

    const peek = store.check({ operation: "tickets", principal: "account:GA", cost: 1 });
    expect(peek.ok).toBe(true);
    expect(barrier.fired).toBe(0);
    expect(usedBy(store, QUOTA_GLOBAL_SUBJECT)).toBe(0);

    // Two real spends still fit, which a leaked check() reservation would deny.
    expect(
      store.consume({ operation: "tickets", principal: "account:GA", cost: 1 }).ok
    ).toBe(true);
    expect(
      store.consume({ operation: "tickets", principal: "account:GB", cost: 1 }).ok
    ).toBe(true);
  });

  it("clears reservations on reset()", () => {
    const barrier = createBarrierStorage();
    const store = makeStore(TIGHT, barrier.storage);

    // Queue an interleave that never runs: the reservation it would have
    // observed must not survive the reset either.
    barrier.interleave(() => undefined);
    store.reset();
    expect(barrier.pending).toBe(1);

    expect(usedBy(store, QUOTA_GLOBAL_SUBJECT)).toBe(0);
    expect(
      store.consume({ operation: "tickets", principal: "account:GA", cost: 2 }).ok
    ).toBe(true);
    expect(usedBy(store, QUOTA_GLOBAL_SUBJECT)).toBe(2);
  });

  it("keeps a nested spend inside the same window as its caller", () => {
    const barrier = createBarrierStorage();
    // The clock advances one millisecond per read, so the inner call lands in
    // the same window while a careless implementation could roll into the next.
    let tick = 0;
    const store = createQuotaStore({
      policies: [TIGHT],
      now: () => START + tick++,
      storage: barrier.storage
    });

    let inner = null as ReturnType<QuotaStore["consume"]> | null;
    barrier.interleave(() => {
      inner = store.consume({
        operation: "tickets",
        principal: "account:GB",
        cost: 1,
        correlationId: "inner"
      });
    });
    const outer = store.consume({
      operation: "tickets",
      principal: "account:GA",
      cost: 1,
      correlationId: "outer"
    });

    expect(barrier.fired).toBe(1);
    expect(outer.ok && inner?.ok).toBe(true);
    if (outer.ok && inner?.ok) {
      expect(inner.value.windowStart).toBe(outer.value.windowStart);
    }
    expect(usedBy(store, QUOTA_GLOBAL_SUBJECT)).toBe(2);
  });
});
