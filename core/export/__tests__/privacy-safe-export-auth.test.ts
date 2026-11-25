import { describe, expect, it, beforeEach } from "vitest";
import {
  exportRecords,
  createExportIdempotencyStore,
  createExportQuotaStore,
  EXPORT_CURRENT_SCHEMA_VERSION,
  type ExportRecordSource,
  type ExportActor
} from "../exporter";
import { createMemoryQuotaStorage, createQuotaStore } from "@/core/quota/quota";
import { createIdempotencyStore } from "@/core/idempotency/idempotency";

describe("Issue #413: Privacy-Safe Export with Field-Level Authorization", () => {
  beforeEach(() => {
    createExportIdempotencyStore(createIdempotencyStore());
    createExportQuotaStore(createQuotaStore({ storage: createMemoryQuotaStorage() }));
  });

  const testSource: ExportRecordSource = {
    recordType: "user_audit_log",
    schemaVersion: EXPORT_CURRENT_SCHEMA_VERSION,
    scope: "own",
    fieldRules: [
      { field: "auditNote", minScope: "maintainer", onDenied: "mask" },
      { field: "diagnosticLatency", minScope: "maintainer", onDenied: "omit" },
      { field: "financialSecret", requiredPermissions: ["export:finance"], onDenied: "omit" }
    ],
    collect: () => [
      {
        id: "rec-101",
        account: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
        amount: "500.00",
        currency: "XLM",
        auditNote: "Compliance review completed",
        diagnosticLatency: 84,
        financialSecret: "FIN-CODE-8844"
      }
    ]
  };

  describe("normal path", () => {
    it("exports permitted fields while masking and omitting unauthorized fields", () => {
      const actor: ExportActor = { kind: "user", id: "user-1", permissions: [] };
      const res = exportRecords(
        {
          schemaVersion: EXPORT_CURRENT_SCHEMA_VERSION,
          scope: "own",
          actor
        },
        [testSource]
      );

      expect(res.ok).toBe(true);
      if (!res.ok) return;

      const record = res.value.records[0];
      // Permitted fields remain intact
      expect(record.id).toBe("rec-101");
      expect(record.amount).toBe("500.00");
      expect(record.currency).toBe("XLM");

      // Masked field (onDenied: mask)
      expect(record.auditNote).toBe("[FILTERED: UNAUTHORIZED]");

      // Omitted fields (onDenied: omit)
      expect(record.diagnosticLatency).toBeUndefined();
      expect(record.financialSecret).toBeUndefined();
    });

    it("permits access to sensitive fields when user holds the required granular permission", () => {
      const actorWithFinance: ExportActor = {
        kind: "user",
        id: "finance-officer",
        permissions: ["export:finance"]
      };

      const res = exportRecords(
        {
          schemaVersion: EXPORT_CURRENT_SCHEMA_VERSION,
          scope: "own",
          actor: actorWithFinance
        },
        [testSource]
      );

      expect(res.ok).toBe(true);
      if (!res.ok) return;

      const record = res.value.records[0];
      expect(record.financialSecret).toBe("FIN-CODE-8844");
      // Other unauthorized maintainer fields are still masked/omitted
      expect(record.auditNote).toBe("[FILTERED: UNAUTHORIZED]");
      expect(record.diagnosticLatency).toBeUndefined();
    });

    it("supports explicit field projection of authorized subset", () => {
      const actor: ExportActor = { kind: "user", id: "user-1" };
      const res = exportRecords(
        {
          schemaVersion: EXPORT_CURRENT_SCHEMA_VERSION,
          scope: "own",
          actor,
          fields: ["id", "amount"]
        },
        [testSource]
      );

      expect(res.ok).toBe(true);
      if (!res.ok) return;

      const record = res.value.records[0];
      expect(record.id).toBe("rec-101");
      expect(record.amount).toBe("500.00");
      expect(record.currency).toBeUndefined();
      expect(record.auditNote).toBeUndefined();
    });
  });

  describe("failure paths and validation guards", () => {
    it("returns field_authorization_denied when strictFields: true and unpermitted field is requested", () => {
      const actor: ExportActor = { kind: "user", id: "user-1" };
      const res = exportRecords(
        {
          schemaVersion: EXPORT_CURRENT_SCHEMA_VERSION,
          scope: "own",
          actor,
          fields: ["id", "diagnosticLatency"],
          strictFields: true
        },
        [testSource]
      );

      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe("field_authorization_denied");
    });

    it("returns schema_unsupported when requesting an obsolete or future schema", () => {
      const res = exportRecords(
        {
          schemaVersion: "99.0",
          scope: "own",
          actor: { kind: "user" }
        },
        [testSource]
      );

      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe("schema_unsupported");
    });

    it("returns export_denied when plain user requests maintainer scope", () => {
      const res = exportRecords(
        {
          schemaVersion: EXPORT_CURRENT_SCHEMA_VERSION,
          scope: "maintainer",
          actor: { kind: "user" }
        },
        [testSource]
      );

      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe("export_denied");
    });
  });

  describe("authorization path", () => {
    it("permits maintainer full unredacted access across all fields", () => {
      const maintainerActor: ExportActor = { kind: "maintainer", id: "super-admin" };
      const res = exportRecords(
        {
          schemaVersion: EXPORT_CURRENT_SCHEMA_VERSION,
          scope: "maintainer",
          actor: maintainerActor
        },
        [testSource]
      );

      expect(res.ok).toBe(true);
      if (!res.ok) return;

      const record = res.value.records[0];
      expect(record.id).toBe("rec-101");
      expect(record.auditNote).toBe("Compliance review completed");
      expect(record.diagnosticLatency).toBe(84);
      expect(record.financialSecret).toBe("FIN-CODE-8844");
    });
  });

  describe("retry and idempotency path", () => {
    it("replays identical export envelope on idempotent retry without deducting additional quota", () => {
      const idemKey = "export-key-413-replay";

      const res1 = exportRecords(
        {
          schemaVersion: EXPORT_CURRENT_SCHEMA_VERSION,
          scope: "own",
          actor: { kind: "user" },
          idempotencyKey: idemKey
        },
        [testSource]
      );
      expect(res1.ok).toBe(true);
      if (!res1.ok) return;

      const res2 = exportRecords(
        {
          schemaVersion: EXPORT_CURRENT_SCHEMA_VERSION,
          scope: "own",
          actor: { kind: "user" },
          idempotencyKey: idemKey
        },
        [testSource]
      );
      expect(res2.ok).toBe(true);
      if (!res2.ok) return;

      expect(res2.value.generatedAt).toBe(res1.value.generatedAt);
      expect(res2.value.correlationId).toBe(res1.value.correlationId);
      expect(res2.value.recordCount).toBe(res1.value.recordCount);
    });
  });
});
