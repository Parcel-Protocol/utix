import { describe, expect, it } from "vitest";
import type { DomainState, Ticket } from "@/core/invariants/types";
import type { TransferTicketParams } from "@/core/invariants/mutations";
import {
  DEFAULT_TRANSFER_RISK_POLICY,
  assessTransferRisk,
  explainRiskAssessment,
  explainRiskAssessmentForActor
} from "../policy";
import type { RiskExplainerActor } from "../types";

const NOW = 1_850_000_000_000;
const testCtx = { now: NOW, deviceId: "device-high-impact-1" };

function buildState(): DomainState {
  const ticket: Ticket = {
    id: "ticket-high-impact",
    eventId: "event-main",
    tierId: "vip",
    ownerAddress: "alice-signer",
    priceStroops: 50_000,
    status: "issued",
    issuedAt: NOW - 86_400_000,
    validFrom: NOW + 3_600_000,
    validUntil: NOW + 7_200_000,
    fraudFlag: false,
    nonce: 0,
    metadataHash: "hash-001"
  };

  return {
    events: new Map([
      ["event-main", { id: "event-main", organizerAddress: "org-key", totalCapacity: 200, issuedCount: 1, status: "active", feeBasisPoints: 100 }]
    ]),
    tickets: new Map([[ticket.id, ticket]]),
    transfers: [],
    processedNonces: new Set(),
    blacklistedAddresses: new Set()
  };
}

function buildRequest(overrides: Partial<TransferTicketParams> = {}): TransferTicketParams {
  return {
    id: "tx-high-impact",
    ticketId: "ticket-high-impact",
    fromAddress: "alice-signer",
    toAddress: "charlie-signer",
    priceStroops: 50_000,
    organizerFeeStroops: 500,
    protocolFeeStroops: 500,
    sellerProceedsStroops: 49_000,
    nonce: "nonce-high-impact",
    ...overrides
  };
}

describe("Explainable Risk Scoring for High-Impact Actions (#461)", () => {
  const maintainer: RiskExplainerActor = { role: "maintainer", id: "staff-lead" };
  const attendee: RiskExplainerActor = { role: "attendee", id: "public-user" };

  describe("Normal Path", () => {
    it("explains clean high-impact transfer with full breakdown for authorized reviewer", () => {
      const assessment = assessTransferRisk(buildState(), buildRequest(), testCtx);
      const explanation = explainRiskAssessmentForActor(assessment, maintainer);

      expect(explanation.disposition).toBe("allow");
      expect(explanation.code).toBe("transfer_completed");
      if (!("isSanitized" in explanation)) {
        expect(explanation.score).toBe(0);
        expect(explanation.signals).toHaveLength(0);
        expect(explanation.explanations).toHaveLength(0);
        expect(explanation.summary).toContain("Score: 0");
        expect(explanation.policyThresholds.reviewScore).toBe(40);
        expect(explanation.policyThresholds.blockScore).toBe(80);
      } else {
        expect.unreachable();
      }
    });
  });

  describe("Failure Path", () => {
    it("handles invalid risk configuration gracefully and hides internal thresholds from explanation", () => {
      const badCtx = {
        now: NOW,
        policy: { ...DEFAULT_TRANSFER_RISK_POLICY, reviewScore: -50 }
      };
      const assessment = assessTransferRisk(buildState(), buildRequest(), badCtx);
      const explained = explainRiskAssessment(assessment, DEFAULT_TRANSFER_RISK_POLICY);

      expect(explained.code).toBe("invalid_risk_context");
      expect(explained.disposition).toBe("block");
      expect(explained.explanations).toHaveLength(0);
      expect(explained.summary).toContain("invalid");
    });
  });

  describe("Retry Path", () => {
    it("flags repeated transfer attempts across short intervals with per-signal explanation", () => {
      const pastAttempts = Array.from({ length: 4 }, (_, i) => ({
        id: `prev-${i}`,
        request: buildRequest({ id: `prev-${i}`, nonce: `n-${i}` }),
        ticketVersion: 0,
        submittedAt: NOW - 200 + i,
        status: "completed" as const,
        score: 0,
        signals: [],
        deviceId: "device-high-impact-1"
      }));

      const stateWithAttempts: DomainState = {
        ...buildState(),
        transferRisk: { attempts: pastAttempts, audit: [] }
      };

      const assessment = assessTransferRisk(
        stateWithAttempts,
        buildRequest(),
        { ...testCtx, policy: { ...DEFAULT_TRANSFER_RISK_POLICY, maxAttempts: 2 } }
      );

      expect(assessment.signals).toContain("repeated_attempts");
      const explanation = explainRiskAssessment(assessment, { ...DEFAULT_TRANSFER_RISK_POLICY, maxAttempts: 2 });
      const signalExpl = explanation.explanations.find((e) => e.signal === "repeated_attempts");
      expect(signalExpl).toBeDefined();
      expect(signalExpl?.weight).toBe(40);
      expect(signalExpl?.description).toContain("retry window");
    });
  });

  describe("Authorization Path", () => {
    it("sanitizes risk explanations for attendee actors to protect detection heuristics", () => {
      const pastAttempts = Array.from({ length: 4 }, (_, i) => ({
        id: `prev-${i}`,
        request: buildRequest({ id: `prev-${i}`, nonce: `n-${i}` }),
        ticketVersion: 0,
        submittedAt: NOW - 200 + i,
        status: "completed" as const,
        score: 0,
        signals: [],
        deviceId: "device-high-impact-1"
      }));

      const stateWithAttempts: DomainState = {
        ...buildState(),
        transferRisk: { attempts: pastAttempts, audit: [] }
      };

      const assessment = assessTransferRisk(
        stateWithAttempts,
        buildRequest(),
        { ...testCtx, policy: { ...DEFAULT_TRANSFER_RISK_POLICY, maxAttempts: 2 } }
      );

      const privileged = explainRiskAssessmentForActor(assessment, maintainer);
      expect("policyThresholds" in privileged).toBe(true);

      const sanitized = explainRiskAssessmentForActor(assessment, attendee);
      expect("isSanitized" in sanitized).toBe(true);
      expect("policyThresholds" in sanitized).toBe(false);
      expect("explanations" in sanitized).toBe(false);
      expect(sanitized.summary).toContain("administrative review");
    });
  });
});
