import { describe, expect, it } from "vitest";
import type { AuthContext } from "@/core/auth/middleware";
import {
  buildDerivedProjection,
  buildDerivedProjectionAuthorized,
  createMemoryProjectionStore,
  createUpcasterRegistry,
  rollbackDerivedProjection,
  rollbackDerivedProjectionAuthorized,
  type DerivedProjectionSpec,
  type EventSource,
  type ReplayEvent
} from "@/core/replay";

const MAINTAINER: AuthContext = { role: "maintainer", userId: "ops-admin" };
const VIEWER: AuthContext = { role: "viewer", userId: "viewer-1" };

interface AccountStats {
  readonly accounts: Record<string, { balance: number; transactions: number }>;
}

function event(sequence: number, type: string, version: number, payload: unknown): ReplayEvent {
  return {
    id: `evt-${sequence}`,
    sequence,
    type,
    version,
    payload,
    occurredAt: "2026-11-20T00:00:00.000Z"
  };
}

function createSource(events: readonly ReplayEvent[]): EventSource {
  return {
    read: async (after: number, limit: number) => {
      return events.filter((e) => e.sequence > after).slice(0, limit);
    }
  };
}

describe("Versioned Event Replay for Derived Projections (#439)", () => {
  const events: ReplayEvent[] = [
    event(1, "account.created", 1, { accountId: "GA1", initialDeposit: 100 }),
    event(2, "account.created", 1, { accountId: "GB2", initialDeposit: 50 }),
    // v1 payment: decimal string "25.0"
    event(3, "payment.sent", 1, { from: "GA1", to: "GB2", amount: "25.0" }),
    // v2 payment: integer amount 10
    event(4, "payment.sent", 2, { from: "GA1", to: "GB2", integerAmount: 10 })
  ];

  const upcasters = createUpcasterRegistry([
    {
      type: "payment.sent",
      fromVersion: 1,
      upcast: (payload) => {
        const p = payload as { from: string; to: string; amount: string };
        return {
          from: p.from,
          to: p.to,
          integerAmount: Math.round(Number(p.amount))
        };
      }
    }
  ]);

  const projectionSpec: DerivedProjectionSpec<AccountStats> = {
    name: "account_ledger_summary",
    version: 1,
    eventVersions: { "account.created": 1, "payment.sent": 2 },
    initial: () => ({ accounts: {} }),
    apply: (state, e) => {
      const next: Record<string, { balance: number; transactions: number }> = {};
      for (const [k, v] of Object.entries(state.accounts)) {
        next[k] = { ...v };
      }

      if (e.type === "account.created") {
        const p = e.payload as { accountId: string; initialDeposit: number };
        next[p.accountId] = { balance: p.initialDeposit, transactions: 1 };
      } else if (e.type === "payment.sent") {
        const p = e.payload as { from: string; to: string; integerAmount: number };
        if (next[p.from]) {
          next[p.from].balance -= p.integerAmount;
          next[p.from].transactions++;
        }
        if (next[p.to]) {
          next[p.to].balance += p.integerAmount;
          next[p.to].transactions++;
        }
      }
      return { accounts: next };
    },
    validate: (state) => {
      const errors: string[] = [];
      for (const [acc, data] of Object.entries(state.accounts)) {
        if (data.balance < 0) errors.push(`Negative balance detected on ${acc}: ${data.balance}`);
      }
      return errors;
    }
  };

  describe("Normal path", () => {
    it("replays versioned events with upcasters and promotes projection atomically", async () => {
      const store = createMemoryProjectionStore();
      const source = createSource(events);

      const result = await buildDerivedProjection(
        projectionSpec,
        { source, store, auth: MAINTAINER, upcasters },
        { promote: true }
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.status).toBe("promoted");
      expect(result.value.activeVersion).toBe(1);
      expect(result.value.eventsProcessed).toBe(4);
      expect(result.value.lastSequence).toBe(4);

      // Verify projected state
      const ga1 = result.value.state.accounts["GA1"];
      const gb2 = result.value.state.accounts["GB2"];
      expect(ga1.balance).toBe(65); // 100 - 25 - 10
      expect(gb2.balance).toBe(85); // 50 + 25 + 10
    });

    it("supports point-in-time rebuild using untilSequence", async () => {
      const store = createMemoryProjectionStore();
      const source = createSource(events);

      const result = await buildDerivedProjection(
        projectionSpec,
        { source, store, auth: MAINTAINER, upcasters },
        { untilSequence: 2, promote: false }
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.eventsProcessed).toBe(2);
      expect(result.value.lastSequence).toBe(2);
      expect(result.value.state.accounts["GA1"].balance).toBe(100);
      expect(result.value.state.accounts["GB2"].balance).toBe(50);
    });
  });

  describe("Failure path", () => {
    it("rejects promotion when validation invariants fail and leaves active pointer unchanged", async () => {
      const store = createMemoryProjectionStore();
      // Overdraw GA1: 100 - 200 = -100
      const invalidEvents: ReplayEvent[] = [
        event(1, "account.created", 1, { accountId: "GA1", initialDeposit: 100 }),
        event(2, "payment.sent", 2, { from: "GA1", to: "GB2", integerAmount: 200 })
      ];
      const source = createSource(invalidEvents);

      const result = await buildDerivedProjection(
        projectionSpec,
        { source, store, auth: MAINTAINER, upcasters },
        { promote: true }
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("validation_failed");

      // Active version pointer must NOT be promoted
      const active = await store.getActive("account_ledger_summary");
      expect(active).toBeUndefined();
    });
  });

  describe("Retry and Resume path", () => {
    it("resumes projection rebuild from durable checkpoint sequence", async () => {
      const store = createMemoryProjectionStore();
      const source = createSource(events);

      // Step 1: Replay until sequence 2
      const step1 = await buildDerivedProjection(
        projectionSpec,
        { source, store, auth: MAINTAINER, upcasters },
        { untilSequence: 2, promote: false }
      );
      expect(step1.ok).toBe(true);

      // Step 2: Resume from checkpoint sequence 2 to head
      const step2 = await buildDerivedProjection(
        projectionSpec,
        { source, store, auth: MAINTAINER, upcasters },
        { mode: "resume", promote: true }
      );

      expect(step2.ok).toBe(true);
      if (!step2.ok) return;
      expect(step2.value.status).toBe("promoted");
      expect(step2.value.eventsProcessed).toBe(2); // Only processed events 3 and 4
      expect(step2.value.lastSequence).toBe(4);
    });
  });

  describe("Authorization and Rollback path", () => {
    it("permits authorized maintainers to build and rollback projections", async () => {
      const store = createMemoryProjectionStore();
      const source = createSource(events);

      // 1. Build v1 and promote
      const v1Result = await buildDerivedProjectionAuthorized(
        MAINTAINER,
        projectionSpec,
        { source, store, upcasters },
        { promote: true }
      );
      expect(v1Result.ok).toBe(true);

      // 2. Build v2 with different multiplier and promote
      const v2Spec: DerivedProjectionSpec<AccountStats> = {
        ...projectionSpec,
        version: 2
      };
      const v2Result = await buildDerivedProjectionAuthorized(
        MAINTAINER,
        v2Spec,
        { source, store, upcasters },
        { promote: true }
      );
      expect(v2Result.ok).toBe(true);
      expect(v2Result.value?.activeVersion).toBe(2);

      // 3. Rollback from v2 to v1
      const rbResult = await rollbackDerivedProjectionAuthorized(
        MAINTAINER,
        "account_ledger_summary",
        { source, store }
      );
      expect(rbResult.ok).toBe(true);
      if (!rbResult.ok) return;
      expect(rbResult.value.activeVersion).toBe(1);
      expect(rbResult.value.previousVersion).toBe(2);
    });

    it("rejects unauthorized actors with permission_denied", async () => {
      const store = createMemoryProjectionStore();
      const source = createSource(events);

      const unauthResult = await buildDerivedProjectionAuthorized(
        VIEWER,
        projectionSpec,
        { source, store, upcasters },
        { promote: true }
      );
      expect(unauthResult.ok).toBe(false);
      if (unauthResult.ok) return;
      expect(unauthResult.code).toBe("permission_denied");

      const unauthRollback = await rollbackDerivedProjectionAuthorized(
        VIEWER,
        "account_ledger_summary",
        { source, store }
      );
      expect(unauthRollback).toEqual({ ok: false, code: "permission_denied" });
    });
  });
});
