import { describe, expect, it } from "vitest";
import {
  EXPORT_CURRENT_SCHEMA_VERSION,
  EXPORT_DEFAULT_TTL_MS,
  EXPORT_GENERATOR,
  authorizeExport,
  exportRecords,
  isExportExpired,
  type ExportRecordSource
} from "@/core/export/exporter";

const SECRET_LIKE = "SAKJFPVKPHAWLBQNFI3HK4DXMTPBSVJ6VNK4AXHYJNPEWTTZOFWLZWNW";

function source(
  recordType: string,
  scope: ExportRecordSource["scope"],
  rows: Array<Record<string, unknown>>
): ExportRecordSource {
  return { recordType, schemaVersion: EXPORT_CURRENT_SCHEMA_VERSION, scope, collect: () => rows };
}

const operationLog = source("operation_log", "own", [
  { op: "wallet.detect", result: "success" },
  { op: "horizon.request", result: "failure", address: "GAAAA…" }
]);

const maintainerReport = source("maintenance_report", "maintainer", [
  { op: "maintenance.prune_horizon_clients", ok: true }
]);

const allSources = [operationLog, maintainerReport];

describe("authorization", () => {
  it("denies a maintainer-scope export to a plain user", () => {
    expect(authorizeExport({ kind: "user" }, "maintainer").ok).toBe(false);
    expect(authorizeExport({ kind: "maintainer" }, "maintainer").ok).toBe(true);
    expect(authorizeExport({ kind: "user" }, "own").ok).toBe(true);
  });
});

describe("exportRecords", () => {
  it("returns schema version and generation metadata", () => {
    const result = exportRecords(
      { schemaVersion: EXPORT_CURRENT_SCHEMA_VERSION, scope: "maintainer", actor: { kind: "maintainer" } },
      allSources
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.schemaVersion).toBe(EXPORT_CURRENT_SCHEMA_VERSION);
    expect(result.value.generator).toBe(EXPORT_GENERATOR);
    expect(result.value.generatedAt).toBeTruthy();
    expect(result.value.expiresAt).toBeTruthy();
    expect(result.value.correlationId).toBeTruthy();
    expect(result.value.recordCount).toBe(3);
    expect(result.value.totalRecords).toBe(3);
  });

  it("users cannot export data outside their authorization scope", () => {
    const denied = exportRecords(
      { schemaVersion: EXPORT_CURRENT_SCHEMA_VERSION, scope: "maintainer", actor: { kind: "user" } },
      allSources
    );
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.code).toBe("export_denied");

    const own = exportRecords(
      { schemaVersion: EXPORT_CURRENT_SCHEMA_VERSION, scope: "own", actor: { kind: "user" } },
      allSources
    );
    expect(own.ok).toBe(true);
    if (!own.ok) return;
    // The maintainer-only source never reaches a user export.
    expect(own.value.records).toHaveLength(2);
    expect(own.value.records.every((record) => record.scope !== "maintainer")).toBe(true);
  });

  it("rejects an unsupported schema version", () => {
    const result = exportRecords(
      { schemaVersion: "2.0", scope: "own", actor: { kind: "user" } },
      allSources
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("schema_unsupported");
  });

  it("handles an empty export", () => {
    const result = exportRecords(
      { schemaVersion: EXPORT_CURRENT_SCHEMA_VERSION, scope: "own", actor: { kind: "user" } },
      [source("empty", "own", [])]
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.records).toEqual([]);
    expect(result.value.recordCount).toBe(0);
  });

  it("handles a large export without loss and pages it", () => {
    const rows = Array.from({ length: 5_000 }, (_, i) => ({ index: i }));
    const result = exportRecords(
      {
        schemaVersion: EXPORT_CURRENT_SCHEMA_VERSION,
        scope: "own",
        actor: { kind: "user" },
        pageSize: 100,
        page: 2
      },
      [source("big", "own", rows)]
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.totalRecords).toBe(5_000);
    expect(result.value.records).toHaveLength(100);
    // Page 2 starts at index 100.
    expect(result.value.records[0].index).toBe(100);
    expect(result.value.page).toBe(2);
  });

  it("redacts secret-shaped values out of exports", () => {
    const result = exportRecords(
      { schemaVersion: EXPORT_CURRENT_SCHEMA_VERSION, scope: "own", actor: { kind: "user" } },
      [source("keys", "own", [{ secret: SECRET_LIKE, public: "visible" }])]
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.records[0].secret).toBe("[REDACTED]");
    expect(result.value.records[0].public).toBe("visible");
  });
});

describe("retention", () => {
  it("stamps an expiry inside the default retention window", () => {
    const result = exportRecords(
      { schemaVersion: EXPORT_CURRENT_SCHEMA_VERSION, scope: "own", actor: { kind: "user" } },
      [source("t", "own", [{ a: 1 }])]
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const envelope = result.value;
    const ttl = Date.parse(envelope.expiresAt) - Date.parse(envelope.generatedAt);
    expect(ttl).toBe(EXPORT_DEFAULT_TTL_MS);
    expect(isExportExpired(envelope, Date.parse(envelope.generatedAt))).toBe(false);
    expect(isExportExpired(envelope, Date.parse(envelope.expiresAt) + 1)).toBe(true);
  });
});