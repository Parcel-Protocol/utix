import { describe, expect, it } from "vitest";
import { createSettlementDisputeStore } from "../store";

const claimant = { kind: "user" as const, id: "account:CLAIMANT" };
const stranger = { kind: "user" as const, id: "account:STRANGER" };
const maintainer = { kind: "maintainer" as const, id: "reviewer" };

describe("settlement disputes", () => {
  it("opens, investigates, and resolves a claim with evidence and audit output", () => {
    const store = createSettlementDisputeStore({
      now: () => 1_700_000_000_000,
      newId: (() => { let n = 0; return () => `generated-${++n}`; })()
    });
    const opened = store.open({
      actor: claimant,
      settlementId: "settle-001",
      reason: "Payment was not settled",
      evidence: [{
        kind: "transaction",
        visibility: "public",
        reference: "ledger:123456"
      }]
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    expect(store.investigate({ actor: maintainer, id: opened.value.id }).ok).toBe(true);
    const resolved = store.resolve({
      actor: maintainer,
      id: opened.value.id,
      resolution: "Payout replay confirmed"
    });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.value.status).toBe("resolved");
    expect(store.auditEvents().map((event) => event.action)).toEqual([
      "settlement_dispute.opened",
      "settlement_dispute.investigating",
      "settlement_dispute.resolved"
    ]);
  });

  it("rejects claims and permits a policy-bounded reopen", () => {
    const store = createSettlementDisputeStore();
    const opened = store.open({ actor: claimant, settlementId: "settle-002", reason: "Claim" });
    if (!opened.ok) throw new Error(opened.code);
    expect(store.reject({
      actor: maintainer,
      id: opened.value.id,
      resolution: "Settlement exists and is complete"
    }).ok).toBe(true);
    expect(store.reopen({ actor: maintainer, id: opened.value.id, reason: "new_evidence" }).ok).toBe(true);
    expect(store.reopen({ actor: maintainer, id: opened.value.id }).ok).toBe(false);
  });

  it("prevents duplicate disputes for the same settlement", () => {
    const store = createSettlementDisputeStore();
    const first = store.open({ actor: claimant, settlementId: "settle-003", reason: "Missing payout" });
    const duplicate = store.open({ actor: claimant, settlementId: "settle-003", reason: "Duplicate claim" });
    expect(first.ok).toBe(true);
    expect(duplicate).toEqual({ ok: false, code: "dispute_duplicate" });
  });

  it("does not expose private evidence or private notes to unauthorized users", () => {
    const store = createSettlementDisputeStore();
    const opened = store.open({ actor: claimant, settlementId: "settle-004", reason: "Fee mismatch" });
    if (!opened.ok) throw new Error(opened.code);
    expect(store.addEvidence({
      actor: maintainer,
      id: opened.value.id,
      evidence: {
        kind: "identity",
        visibility: "private",
        reference: "kyc-case:private-1"
      }
    }).ok).toBe(true);
    expect(store.addNote({
      actor: maintainer,
      id: opened.value.id,
      authorized: true,
      note: { visibility: "private", text: "Internal review note" }
    }).ok).toBe(true);

    expect(store.get(opened.value.id, stranger)?.evidence).toEqual([]);
    expect(store.get(opened.value.id, stranger)?.notes).toEqual([]);
    expect(store.get(opened.value.id, maintainer)?.evidence).toHaveLength(1);
    expect(store.get(opened.value.id, claimant)?.evidence).toHaveLength(1);
  });
});
