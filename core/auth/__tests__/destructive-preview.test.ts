import { beforeEach, describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import {
  DestructiveActionPreviewEngine,
  computePreviewDigest
} from "../destructive-preview";
import { MaintainerApprovalManager } from "../maintainer-approval";

const MAINTAINER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 10));
const UNAUTHORIZED = "GBBD6W3NZUBY7J572J45A75Z7P4C0B634S8X2A7X6M27B2B642C3N444";

describe("Issue #354: Dry-Run Preview for Destructive Maintainer Actions", () => {
  let engine: DestructiveActionPreviewEngine;
  let mockTime: number;

  beforeEach(() => {
    mockTime = 1700000000000;
    engine = new DestructiveActionPreviewEngine({
      now: () => mockTime
    });
  });

  describe("Normal Path", () => {
    it("generates pure, side-effect-free dry-run preview with blast radius and rollback plan", () => {
      const result = engine.generatePreview({
        action: "emergency_killswitch",
        target: "horizon-client",
        parameters: { mode: "maintenance" },
        requestedBy: MAINTAINER.publicKey(),
        liveStateSnapshot: { status: "healthy", trafficBlocked: false }
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const preview = result.value;
      expect(preview.action).toBe("emergency_killswitch");
      expect(preview.target).toBe("horizon-client");
      expect(preview.riskLevel).toBe("high");
      expect(preview.reversibility).toBe("reversible");
      expect(preview.status).toBe("valid");

      // Blast radius inspection
      expect(preview.blastRadius.targetResource).toBe("horizon-client");
      expect(preview.blastRadius.cascadingEffects.length).toBeGreaterThan(0);

      // State delta prediction
      expect(preview.stateDelta.beforeState.status).toBe("healthy");
      expect(preview.stateDelta.predictedAfterState.trafficBlocked).toBe(true);
      expect(preview.stateDelta.predictedAfterState.serviceMode).toBe("maintenance");

      // Rollback plan
      expect(preview.rollbackPlan.isAutomated).toBe(true);
      expect(preview.rollbackPlan.steps.length).toBeGreaterThan(0);

      // Digest
      expect(preview.previewDigest).toHaveLength(64);
    });

    it("evaluates irreversible critical action blast radius accurately", () => {
      const result = engine.generatePreview({
        action: "batch_ticket_burn",
        target: "event-999",
        parameters: { ticketIds: ["tkt-1", "tkt-2", "tkt-3"] },
        requestedBy: MAINTAINER.publicKey()
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const preview = result.value;
      expect(preview.riskLevel).toBe("critical");
      expect(preview.reversibility).toBe("irreversible");
      expect(preview.blastRadius.affectedEntityCount).toBe(3);
      expect(preview.rollbackPlan.isAutomated).toBe(false);
      expect(preview.rollbackPlan.steps[0]).toContain("irreversible");
    });
  });

  describe("Authorization Path", () => {
    it("rejects preview generation for unauthorized actor context", () => {
      const result = engine.generatePreview(
        {
          action: "emergency_killswitch",
          target: "network-service",
          requestedBy: UNAUTHORIZED
        },
        {
          role: "viewer",
          userId: "viewer-1"
        }
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("unauthorized_actor");
    });

    it("allows preview generation for authorized maintainer context", () => {
      const result = engine.generatePreview(
        {
          action: "admin_config_override",
          target: "rate-limits",
          parameters: { maxRequestsPerMinute: 5000 },
          requestedBy: MAINTAINER.publicKey()
        },
        {
          role: "maintainer",
          userId: MAINTAINER.publicKey()
        }
      );

      expect(result.ok).toBe(true);
    });
  });

  describe("Failure Path", () => {
    it("rejects preview when target is empty or invalid", () => {
      const result = engine.generatePreview({
        action: "emergency_killswitch",
        target: "",
        requestedBy: MAINTAINER.publicKey()
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("invalid_target");
    });

    it("fails validation when required action parameters are missing or malformed", () => {
      const result = engine.generatePreview({
        action: "batch_ticket_burn",
        target: "event-1",
        parameters: { ticketIds: [] }, // empty list!
        requestedBy: MAINTAINER.publicKey()
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("validation_failed");
    });
  });

  describe("Retry & Drift Protection Path", () => {
    it("detects live state drift between dry-run preview and execution", () => {
      const previewRes = engine.generatePreview({
        action: "quota_override",
        target: "account-alpha",
        parameters: { limit: 2000 },
        requestedBy: MAINTAINER.publicKey(),
        liveStateSnapshot: { limit: 500 }
      });

      expect(previewRes.ok).toBe(true);
      if (!previewRes.ok) return;

      const previewId = previewRes.value.previewId;

      // Drift scenario: live state limit changed from 500 to 800 before execution
      const verifyRes = engine.verifyPreviewForExecution(
        previewId,
        { limit: 800 }, // drifted!
        previewRes.value.previewDigest
      );

      expect(verifyRes.ok).toBe(false);
      if (verifyRes.ok) return;
      expect(verifyRes.code).toBe("state_drift_detected");
    });

    it("allows execution when state has not drifted", () => {
      const previewRes = engine.generatePreview({
        action: "quota_override",
        target: "account-alpha",
        parameters: { limit: 2000 },
        requestedBy: MAINTAINER.publicKey(),
        liveStateSnapshot: { limit: 500 }
      });

      expect(previewRes.ok).toBe(true);
      if (!previewRes.ok) return;

      const verifyRes = engine.verifyPreviewForExecution(
        previewRes.value.previewId,
        { limit: 500 }, // matches dry-run beforeState!
        previewRes.value.previewDigest
      );

      expect(verifyRes.ok).toBe(true);
    });

    it("rejects execution of expired preview", () => {
      const previewRes = engine.generatePreview({
        action: "emergency_killswitch",
        target: "service-1",
        expiresInMs: 1000,
        requestedBy: MAINTAINER.publicKey()
      });

      expect(previewRes.ok).toBe(true);
      if (!previewRes.ok) return;

      // Fast forward time past expiry
      mockTime += 2000;

      const verifyRes = engine.verifyPreviewForExecution(
        previewRes.value.previewId,
        { status: "active", target: "service-1" }
      );

      expect(verifyRes.ok).toBe(false);
      if (verifyRes.ok) return;
      expect(verifyRes.code).toBe("preview_expired");
    });

    it("prevents replay consumption of the same preview", () => {
      const previewRes = engine.generatePreview({
        action: "quota_override",
        target: "account-beta",
        parameters: { limit: 100 },
        requestedBy: MAINTAINER.publicKey()
      });

      expect(previewRes.ok).toBe(true);
      if (!previewRes.ok) return;

      const previewId = previewRes.value.previewId;

      // Consume once
      const consume1 = engine.consumePreview(previewId, MAINTAINER.publicKey());
      expect(consume1.ok).toBe(true);

      // Verify cannot be consumed or executed again
      const consume2 = engine.consumePreview(previewId, MAINTAINER.publicKey());
      expect(consume2.ok).toBe(false);
      if (consume2.ok) return;
      expect(consume2.code).toBe("preview_already_consumed");
    });
  });

  describe("Integration with MaintainerApprovalManager", () => {
    it("seamlessly previews and verifies through approval manager", async () => {
      const manager = new MaintainerApprovalManager({
        now: () => new Date(mockTime)
      });

      const previewRes = manager.previewDryRun({
        action: "admin_config_override",
        target: "global-fees",
        parameters: { baseFeeStroops: 200 },
        requestedBy: MAINTAINER.publicKey(),
        liveStateSnapshot: { baseFeeStroops: 100 }
      });

      expect(previewRes.ok).toBe(true);
      if (!previewRes.ok) return;

      const preview = previewRes.value;
      expect(preview.action).toBe("admin_config_override");
      expect(preview.stateDelta.predictedAfterState.baseFeeStroops).toBe(200);
    });
  });
});
