import { describe, expect, it } from "vitest";
import {
  scanForSensitiveLeaks,
  verifyPrivacyCompliance,
  sanitizeExportRecordWithPrivacy,
  sanitizeLogEvent
} from "../redaction-policy";
import { redact, type TelemetryEvent } from "@/core/telemetry/telemetry";
import { type ExportActor } from "@/core/export/exporter";

describe("privacy redaction for logs and exports (#432)", () => {
  const secretSeed = "SAKJFPVKPHAWLBQNFI3HK4DXMTPBSVJ6VNK4AXHYJNPEWTTZOFWLZWNW";
  const bearerToken = "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";

  const userActor: ExportActor = { kind: "user" };
  const maintainerActor: ExportActor = { kind: "maintainer" };

  describe("normal path", () => {
    it("redacts secret seeds and auth headers in telemetry log events", () => {
      const rawEvent: TelemetryEvent = {
        op: "horizon.request",
        actorType: "client",
        result: "success",
        latencyMs: 45,
        correlationId: "corr-1",
        timestamp: "2026-01-01T00:00:00.000Z",
        payload: {
          account: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H",
          secretSeed,
          authHeader: bearerToken,
          healthy: true
        }
      };

      const sanitized = sanitizeLogEvent(rawEvent);
      expect(sanitized.payload?.secretSeed).toBe("[REDACTED]");
      expect(sanitized.payload?.authHeader).toBe("[REDACTED]");
      expect(sanitized.payload?.account).toBe(
        "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H"
      );
      expect(sanitized.payload?.healthy).toBe(true);

      const auditCheck = verifyPrivacyCompliance(sanitized);
      expect(auditCheck.ok).toBe(true);
    });

    it("sanitizes export records according to actor role (masking & omitting maintainer-only fields)", () => {
      const exportRecord = {
        id: "tx-501",
        amount: "250.00",
        currency: "XLM",
        adminNotes: "Suspicious activity check",
        internalLatencyMs: 98,
        sessionToken: "tok-abc-123"
      };

      const userSanitized = sanitizeExportRecordWithPrivacy(exportRecord, userActor);
      expect(userSanitized.id).toBe("tx-501");
      expect(userSanitized.amount).toBe("250.00");
      // Admin notes masked or omitted
      expect(userSanitized.sessionToken).toBe("[REDACTED]");
      expect(userSanitized.adminNotes).toBe("[MASKED]");
      expect(userSanitized.internalLatencyMs).toBeUndefined();

      const compliance = verifyPrivacyCompliance(userSanitized);
      expect(compliance.ok).toBe(true);
    });
  });

  describe("failure & leak interception path", () => {
    it("detects unredacted secret seed leak and reports violation", () => {
      const leakedData = {
        user: "alice",
        keyDump: `Failed key: ${secretSeed}`
      };

      const report = verifyPrivacyCompliance(leakedData);
      expect(report.ok).toBe(false);
      if (!report.ok) {
        expect(report.code).toBe("unredacted_secret_detected");
      }

      const leaks = scanForSensitiveLeaks(leakedData);
      expect(leaks.length).toBeGreaterThan(0);
      expect(leaks[0]).toContain("Unredacted Stellar secret seed");
    });

    it("detects unredacted bearer token header", () => {
      const leakedHeaders = {
        host: "stellar.api",
        authorization: bearerToken
      };

      const leaks = scanForSensitiveLeaks(leakedHeaders);
      expect(leaks.some((l) => l.includes("Bearer token") || l.includes("authorization"))).toBe(
        true
      );
    });
  });

  describe("retry & persistence path", () => {
    it("maintains consistent privacy scrub across repeated retry attempts", () => {
      const dirtyLog = {
        op: "worker.retry",
        actorType: "worker" as const,
        result: "failure" as const,
        latencyMs: 120,
        correlationId: "corr-retry",
        timestamp: "2026-01-01T00:00:00.000Z",
        payload: {
          attempt: 1,
          secret: secretSeed
        }
      };

      for (let attempt = 1; attempt <= 3; attempt++) {
        const attemptLog = { ...dirtyLog, payload: { ...dirtyLog.payload, attempt } };
        const scrubbed = sanitizeLogEvent(attemptLog);
        expect(scrubbed.payload?.secret).toBe("[REDACTED]");
        expect(verifyPrivacyCompliance(scrubbed).ok).toBe(true);
      }
    });
  });

  describe("authorization & role differentiation path", () => {
    it("allows privileged maintainer to access operational diagnostics while protecting core secrets", () => {
      const auditRecord = {
        id: "rec-800",
        adminNotes: "Verified identity",
        internalLatencyMs: 33,
        secretKey: secretSeed
      };

      const maintainerSanitized = sanitizeExportRecordWithPrivacy(auditRecord, maintainerActor);
      expect(maintainerSanitized.adminNotes).toBe("Verified identity");
      expect(maintainerSanitized.internalLatencyMs).toBe(33);
      // Secrets must ALWAYS be redacted even for maintainers
      expect(maintainerSanitized.secretKey).toBe("[REDACTED]");
    });
  });

  describe("edge cases: circular references and deep structures", () => {
    it("safely handles circular references and deep objects without crashing", () => {
      const cyclic: Record<string, unknown> = {
        name: "test-cycle",
        secret: secretSeed
      };
      cyclic.self = cyclic;

      const redacted = redact(cyclic) as Record<string, unknown>;
      expect(redacted.secret).toBe("[REDACTED]");
      expect(redacted.self).toBe("[CIRCULAR]");
      expect(() => JSON.stringify(redacted)).not.toThrow();
    });
  });
});
