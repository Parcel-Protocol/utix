import { describe, expect, it } from "vitest";
import type { DomainState, Ticket } from "@/core/invariants/types";
import type { TransferTicketParams } from "@/core/invariants/mutations";
import { DEFAULT_TRANSFER_RISK_POLICY, assessTransferRisk, explainRiskAssessment } from "../policy";

const NOW = 1_800_000_000_000;
const context = { now: NOW, deviceId: "device-one" };

function state(): DomainState {
  const ticket: Ticket = {
    id: "ticket", eventId: "event", tierId: "general", ownerAddress: "alice", priceStroops: 100,
    status: "issued", issuedAt: NOW - 86_400_000, validFrom: NOW + 3_600_000,
    validUntil: NOW + 7_200_000, fraudFlag: false, nonce: 0, metadataHash: ""
  };
  return {
    events: new Map([["event", { id: "event", organizerAddress: "organizer", totalCapacity: 100, issuedCount: 1, status: "active", feeBasisPoints: 0 }]]),
    tickets: new Map([[ticket.id, ticket]]),
    transfers: [], processedNonces: new Set(), blacklistedAddresses: new Set()
  };
}

function request(overrides: Partial<TransferTicketParams> = {}): TransferTicketParams {
  return {
    id: "transfer", ticketId: "ticket", fromAddress: "alice", toAddress: "bob", priceStroops: 100,
    organizerFeeStroops: 5, protocolFeeStroops: 5, sellerProceedsStroops: 90, nonce: "nonce", ...overrides
  };
}

function risky(): DomainState {
  return {
    ...state(),
    transfers: [{ ...request({ id: "previous", nonce: "previous-nonce", fromAddress: "previous-owner", toAddress: "alice" }), timestamp: NOW - 1000 }]
  };
}

describe("Explainable risk scoring for high-impact actions (#417)", () => {
  it("explains a normal low-risk transfer with no signals", () => {
    const assessment = assessTransferRisk(state(), request(), context);
    const explained = explainRiskAssessment(assessment, DEFAULT_TRANSFER_RISK_POLICY);
    expect(explained.signals).toEqual([]);
    expect(explained.explanations).toEqual([]);
    expect(explained.summary).toContain("Score: 0");
    expect(explained.summary).toContain("no risk signals triggered");
    expect(explained.disposition).toBe("allow");
  });

  it("explains a review-required transfer with per-signal breakdown", () => {
    const assessment = assessTransferRisk(risky(), request(), context);
    const explained = explainRiskAssessment(assessment, DEFAULT_TRANSFER_RISK_POLICY);
    expect(explained.signals).toEqual(["rapid_resale"]);
    expect(explained.explanations).toHaveLength(1);
    expect(explained.explanations[0].signal).toBe("rapid_resale");
    expect(explained.explanations[0].weight).toBe(40);
    expect(explained.explanations[0].description).toContain("rapid resale");
    expect(explained.summary).toContain("rapid_resale (+40)");
    expect(explained.summary).toContain("manual review is required");
    expect(explained.policyThresholds).toEqual({ reviewScore: 40, blockScore: 80 });
  });

  it("explains a blocked transfer with combined signals", () => {
    const transfers = Array.from({ length: 5 }, (_, i) => ({
      ...request({ id: `other-${i}`, nonce: `other-${i}`, ticketId: `other-${i}` }),
      timestamp: NOW - 500
    }));
    const assessment = assessTransferRisk({ ...risky(), transfers: [...risky().transfers, ...transfers] }, request(), context);
    const explained = explainRiskAssessment(assessment, DEFAULT_TRANSFER_RISK_POLICY);
    expect(explained.disposition).toBe("block");
    expect(explained.signals).toContain("rapid_resale");
    expect(explained.signals).toContain("recipient_pattern");
    expect(explained.summary).toContain("blocked");
    expect(explained.explanations.length).toBe(explained.signals.length);
  });

  it("explains an invalid risk context without leaking thresholds", () => {
    const assessment = assessTransferRisk(state(), request(), {
      policy: { ...DEFAULT_TRANSFER_RISK_POLICY, reviewScore: -1 }
    });
    const explained = explainRiskAssessment(assessment, DEFAULT_TRANSFER_RISK_POLICY);
    expect(explained.code).toBe("invalid_risk_context");
    expect(explained.explanations).toEqual([]);
    expect(explained.summary).toContain("invalid");
    expect(explained.summary).not.toContain("reviewScore");
  });

  it("includes policy thresholds in the explanation for authorized review", () => {
    const assessment = assessTransferRisk(risky(), request(), context);
    const explained = explainRiskAssessment(assessment, DEFAULT_TRANSFER_RISK_POLICY);
    expect(explained.policyThresholds.reviewScore).toBe(40);
    expect(explained.policyThresholds.blockScore).toBe(80);
  });

  it("covers failure path: ticket not found produces a block explanation", () => {
    const assessment = assessTransferRisk(state(), request({ ticketId: "missing" }), context);
    expect(assessment.disposition).toBe("block");
    const explained = explainRiskAssessment(assessment, DEFAULT_TRANSFER_RISK_POLICY);
    expect(explained.disposition).toBe("block");
    expect(explained.summary).toContain("blocked");
  });

  it("retry path: repeated attempts signal is explained with correct weight", () => {
    const attempts = Array.from({ length: 5 }, (_, i) => ({
      id: `history-${i}`, request: request({ id: `history-${i}`, nonce: `history-${i}`, ticketId: `old-${i}` }),
      ticketVersion: 0, submittedAt: NOW - 1000 + i, status: "completed" as const, score: 0, signals: [], deviceId: "device"
    }));
    const assessment = assessTransferRisk(
      { ...state(), transferRisk: { attempts, audit: [] } },
      request(),
      { ...context, policy: { ...DEFAULT_TRANSFER_RISK_POLICY, maxAttempts: 3 } }
    );
    expect(assessment.signals).toContain("repeated_attempts");
    const explained = explainRiskAssessment(assessment, { ...DEFAULT_TRANSFER_RISK_POLICY, maxAttempts: 3 });
    const repeatedExplanation = explained.explanations.find((e) => e.signal === "repeated_attempts");
    expect(repeatedExplanation).toBeDefined();
    expect(repeatedExplanation!.weight).toBe(40);
    expect(repeatedExplanation!.description).toContain("retry window");
  });
});
