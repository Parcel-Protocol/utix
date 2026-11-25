import { describe, expect, it } from "vitest";
import {
  createDriftDetector,
  CrossServiceEventDriftDetector,
  defaultDriftDetector
} from "../drift-detector";

describe("Cross-Service Event Schema Drift Detection (Issue #366)", () => {
  const detector = defaultDriftDetector;

  describe("Normal Path: Clean Event Validation", () => {
    it("validates telemetry.event payload without drift", () => {
      const validTelemetry = {
        op: "horizon.request",
        actorType: "user",
        result: "success",
        latencyMs: 42,
        correlationId: "corr-12345",
        timestamp: new Date().toISOString()
      };

      const result = detector.detectDrift("telemetry.event", validTelemetry, {
        producer: "core/telemetry"
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.compatible).toBe(true);
      expect(result.value.hasBreakingDrift).toBe(false);
      expect(result.value.issues).toHaveLength(0);
      expect(result.value.authorized).toBe(true);
    });

    it("validates worker.job payload produced by a feature slice", () => {
      const validJob = {
        id: "job-abc-123",
        operation: "export.generate",
        attempts: 1,
        status: "queued",
        enqueuedAt: new Date().toISOString(),
        correlationId: "corr-987"
      };

      const result = detector.detectDrift("worker.job", validJob, {
        producer: "features/account-signers"
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.compatible).toBe(true);
      expect(result.value.authorized).toBe(true);
    });

    it("validates ownership.transfer domain event", () => {
      const validOwnershipEvent = {
        id: "ot-100",
        resourceId: "tkt-001",
        currentOwner: "GAAABBB",
        proposedOwner: "GCCCDDD",
        status: "pending",
        expiresAt: Date.now() + 86400000
      };

      const result = detector.detectDrift("ownership.transfer", validOwnershipEvent, {
        producer: "core/ownership"
      });

      expect(result.ok).toBe(true);
    });
  });

  describe("Failure Paths: Missing Fields, Type Mismatches & Malformed Payloads", () => {
    it("detects missing required fields as breaking drift", () => {
      const missingLatency = {
        op: "horizon.request",
        actorType: "user",
        result: "success",
        // latencyMs missing
        correlationId: "corr-12345",
        timestamp: new Date().toISOString()
      };

      const result = detector.detectDrift("telemetry.event", missingLatency);
      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.code).toBe("contract_drift_breaking");
    });

    it("detects field type mismatch as breaking drift", () => {
      const wrongTypeJob = {
        id: "job-abc-123",
        operation: "export.generate",
        attempts: "one", // should be number
        status: "queued",
        enqueuedAt: new Date().toISOString(),
        correlationId: "corr-987"
      };

      const result = detector.detectDrift("worker.job", wrongTypeJob);
      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.code).toBe("contract_drift_breaking");
    });

    it("rejects unknown event contracts", () => {
      const result = detector.detectDrift("unknown.unregistered.event", { foo: "bar" });
      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.code).toBe("unknown_contract");
    });

    it("rejects malformed null or non-object payloads", () => {
      const result = detector.detectDrift("telemetry.event", null);
      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.code).toBe("malformed_payload");
    });
  });

  describe("Authorization Path: Producer Boundary Enforcement", () => {
    it("rejects event when producer is not declared in contract map", () => {
      const validTelemetry = {
        op: "horizon.request",
        actorType: "user",
        result: "success",
        latencyMs: 42,
        correlationId: "corr-12345",
        timestamp: new Date().toISOString()
      };

      const result = detector.detectDrift("telemetry.event", validTelemetry, {
        producer: "unauthorized/external-script"
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.code).toBe("unauthorized_producer");
    });

    it("allows maintainer actor to produce or simulate any event", () => {
      const validTelemetry = {
        op: "horizon.request",
        actorType: "user",
        result: "success",
        latencyMs: 42,
        correlationId: "corr-12345",
        timestamp: new Date().toISOString()
      };

      const result = detector.detectDrift("telemetry.event", validTelemetry, {
        producer: "custom/evaluator",
        actor: { kind: "maintainer", id: "ops-lead" }
      });

      expect(result.ok).toBe(true);
    });
  });

  describe("Retry & Recovery Path: Transient Retries & Schema Evolution Diff", () => {
    it("recovers transient negotiation failure with backoff retry", async () => {
      let attempts = 0;
      const supplier = async () => {
        attempts += 1;
        if (attempts < 2) {
          // Incomplete payload on first attempt
          return { op: "test" };
        }
        // Complete payload on second attempt
        return {
          op: "horizon.request",
          actorType: "user",
          result: "success",
          latencyMs: 42,
          correlationId: "corr-12345",
          timestamp: new Date().toISOString()
        };
      };

      const result = await detector.detectDriftWithRetry("telemetry.event", supplier, {
        maxRetries: 3,
        backoffMs: 5
      });

      expect(result.ok).toBe(true);
      expect(attempts).toBe(2);
    });

    it("compares two schemas and generates backward-compatible evolution diff", () => {
      const v1Schema = {
        version: "1.0",
        fields: {
          id: { type: "string" as const, required: true },
          name: { type: "string" as const, required: true }
        }
      };

      const v1_1Compatible = {
        version: "1.1",
        fields: {
          id: { type: "string" as const, required: true },
          name: { type: "string" as const, required: true },
          description: { type: "string" as const, required: false }
        }
      };

      const diff = detector.compareSchemas(v1Schema, v1_1Compatible, "1.0", "1.1");
      expect(diff.compatible).toBe(true);
      expect(diff.breakingChanges).toHaveLength(0);
      expect(diff.additiveChanges).toContain("Added optional field: 'description'");
    });

    it("flags removed required field as breaking evolution", () => {
      const v1Schema = {
        version: "1.0",
        fields: {
          id: { type: "string" as const, required: true },
          name: { type: "string" as const, required: true }
        }
      };

      const v2Breaking = {
        version: "2.0",
        fields: {
          id: { type: "string" as const, required: true }
          // 'name' removed
        }
      };

      const diff = detector.compareSchemas(v1Schema, v2Breaking, "1.0", "2.0");
      expect(diff.compatible).toBe(false);
      expect(diff.breakingChanges.some(b => b.includes("Removed required field"))).toBe(true);
    });

    it("provides remediation guidance for detected drift", () => {
      const mockReport = {
        eventId: "telemetry.event",
        compatible: false,
        hasBreakingDrift: true,
        issues: [
          {
            path: "latencyMs",
            type: "missing_field" as const,
            severity: "breaking" as const,
            expected: "number",
            actual: "undefined",
            description: "Missing latency",
            remediation: "Ensure producer supplies latencyMs"
          }
        ],
        versionReport: { requested: "1.0", current: "1.0", status: "ok" as const },
        producer: "core/telemetry",
        authorized: true,
        evaluatedAt: new Date().toISOString(),
        correlationId: "corr-mock"
      };

      const suggestions = detector.suggestRemediation(mockReport);
      expect(suggestions[0]).toContain("[BREAKING] latencyMs: Ensure producer supplies latencyMs");
    });
  });
});
