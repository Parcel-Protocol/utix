import { describe, expect, it } from "vitest";
import { monitorFinancialInvariants } from "../invariant-monitor";
import type { DomainState, Ticket } from "@/core/invariants/types";
import type { ReconciliationInput } from "@/core/reconciliation/reconciliation";

const NOW = 1_800_000_000_000;
const emptySnapshot: ReconciliationInput = {
  storedBalances: [], ledgerBalances: [], jobs: [], notifications: [],
  idempotencyRecords: [], exportEnvelopes: [], operations: [], now: NOW
};

const ticket: Ticket = {
  id: "t-1", eventId: "event-1", tierId: "tier-1",
  ownerAddress: "new-owner", priceStroops: 100,
  status: "transferred", issuedAt: NOW - 2000,
  validFrom: NOW - 2000, validUntil: NOW + 2000,
  fraudFlag: false, nonce: 0, metadataHash: "hash"
};
const baseState: DomainState = {
  events: new Map([["event-1", {
    id: "event-1", organizerAddress: "organizer", totalCapacity: 10,
    issuedCount: 1, status: "active" as const, feeBasisPoints: 100
  }]]),
  tickets: new Map([[ticket.id, ticket]]),
  transfers: [{ id: "xfer-1", ticketId: ticket.id, fromAddress: "old-owner",
    toAddress: "new-owner", priceStroops: 100, organizerFeeStroops: 0,
    protocolFeeStroops: 0, sellerProceedsStroops: 100, nonce: "nonce-1", timestamp: NOW - 1000 }],
  processedNonces: new Set(),
  blacklistedAddresses: new Set()
};

describe("invariant monitor", () => {
  it("denies unauthorized monitoring before reading the snapshot", () => {
    expect(monitorFinancialInvariants({ role: "viewer" }, baseState, emptySnapshot)).toMatchObject({ ok: false, code: "unauthorized" });
  });

  it("reports a healthy balance and ownership state", () => {
    const result = monitorFinancialInvariants({ role: "maintainer" }, baseState, emptySnapshot, "health-ok");
    expect(result.ok).toBe(true);
    if (!result.ok) throw Error("expected report");
    expect(result.value).toMatchObject({
      status: "healthy", balanceFindings: 0, ownershipFindings: 0, correlationId: "health-ok"
    });
  });

  it("detects ownership discrepancy and stored-to-ledger amount drift", () => {
    const changed: DomainState = { ...baseState,
      tickets: new Map([[ticket.id, { ...ticket, ownerAddress: "stale-owner" }]]) };
    const snapshot: ReconciliationInput = {
      ...emptySnapshot,
      storedBalances: [{ account: "Gaccount", asset: "native", balance: "1.00" }],
      ledgerBalances: [{ account: "Gaccount", asset: "native", balance: "2.00", reference: "ledger-100" }]
    };
    const result = monitorFinancialInvariants({ role: "maintainer" }, changed, snapshot);
    expect(result.ok).toBe(true);
    if (!result.ok) throw Error("expected report");
    expect(result.value.status).toBe("unhealthy");
    expect(result.value.ownershipFindings).toBe(1);
    expect(result.value.balanceFindings).toBeGreaterThan(0);
    expect(result.value.violations).toEqual(expect.arrayContaining([expect.objectContaining({ id: "INV-02" })]));
  });
});
