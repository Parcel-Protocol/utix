import { describe, expect, it } from "vitest";
import {
  applyFieldLevelAuthorization,
  DEFAULT_SENSITIVE_FIELD_RULES,
  EXPORT_CURRENT_SCHEMA_VERSION,
  type ExportActor
} from "../exporter";
import {
  buildExportFieldReceipt,
  EXPORT_FIELD_AUDIT_PERMISSION,
  isExportFieldReceiptExpired,
  revealExportFieldReceipt,
  revokeExportFieldReceipt,
  verifyExportFieldReceipt,
  type BuildExportFieldReceiptRequest,
  type ExportFieldReceipt
} from "../field-authorization-receipt";

const NOW = Date.parse("2026-11-22T00:00:00.000Z");
const USER: ExportActor = { kind: "user", id: "u-1" };
const OTHER_USER: ExportActor = { kind: "user", id: "u-2" };
const MAINTAINER: ExportActor = { kind: "maintainer", id: "m-1" };
const AUDIT_SERVICE: ExportActor = {
  kind: "service",
  id: "s-1",
  permissions: [EXPORT_FIELD_AUDIT_PERMISSION]
};

function request(overrides: Partial<BuildExportFieldReceiptRequest> = {}): BuildExportFieldReceiptRequest {
  return {
    actor: USER,
    scope: "own",
    recordType: "transaction_audit",
    schemaVersion: EXPORT_CURRENT_SCHEMA_VERSION,
    requestedFields: ["ipAddress", "amount", "internalLatencyMs"],
    key: "export-key-123",
    now: () => NOW,
    ttlMs: 1_000,
    ...overrides
  };
}

function build(overrides: Partial<BuildExportFieldReceiptRequest> = {}): ExportFieldReceipt {
  const result = buildExportFieldReceipt(request(overrides));
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.code);
  return result.value;
}

describe("Field-level export authorization receipts (#457)", () => {
  it("normal path: decisions are sorted, typed, and never contain values", () => {
    const receipt = build();

    expect(receipt.fields.map((field) => field.field)).toEqual([
      "amount",
      "internalLatencyMs",
      "ipAddress"
    ]);
    expect(receipt.fields).toEqual([
      { field: "amount", action: "allow", reason: "no rule" },
      { field: "internalLatencyMs", action: "omit", reason: "scope own < maintainer" },
      { field: "ipAddress", action: "mask", reason: "scope own < maintainer" }
    ]);
    expect(receipt.receiptId).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyExportFieldReceipt(receipt).ok).toBe(true);
    expect(JSON.stringify(receipt)).not.toContain("203.0.113.5");
  });

  it("normal path: receipt decisions agree with the export boundary", () => {
    const receipt = build();
    const { record } = applyFieldLevelAuthorization(
      { amount: "150.00", ipAddress: "203.0.113.5", internalLatencyMs: 45 },
      USER,
      { rules: DEFAULT_SENSITIVE_FIELD_RULES }
    );

    expect(record.amount).toBe("150.00");
    expect(record.ipAddress).toBe("[FILTERED: UNAUTHORIZED]");
    expect(record).not.toHaveProperty("internalLatencyMs");
    expect(receipt.fields.find((field) => field.field === "ipAddress")?.action).toBe("mask");
    expect(receipt.fields.find((field) => field.field === "internalLatencyMs")?.action).toBe("omit");
  });

  it("failure path: malformed inputs are refused with typed codes", () => {
    expect(buildExportFieldReceipt(request({ requestedFields: [] })).ok).toBe(false);
    expect(buildExportFieldReceipt(request({ requestedFields: ["amount", "amount"] })).ok).toBe(false);
    expect(buildExportFieldReceipt(request({ requestedFields: [" "] })).ok).toBe(false);
    expect(buildExportFieldReceipt(request({ key: "short" })).ok).toBe(false);
    expect(buildExportFieldReceipt(request({ schemaVersion: "latest" })).ok).toBe(false);
    expect(buildExportFieldReceipt(request({ ttlMs: 0 })).ok).toBe(false);

    const denied = buildExportFieldReceipt(request({ scope: "maintainer" }));
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.code).toBe("export_receipt_unauthorized");
  });

  it("failure path: a tampered decision or identity is detected", () => {
    const receipt = build();
    const tamperedAction: ExportFieldReceipt = {
      ...receipt,
      fields: receipt.fields.map((field) =>
        field.field === "amount" ? { ...field, action: "mask" } : field
      )
    };
    const tamperedIdentity = { ...receipt, actorId: "attacker" };

    expect(verifyExportFieldReceipt(tamperedAction).ok).toBe(false);
    expect(verifyExportFieldReceipt(tamperedIdentity).ok).toBe(false);
    expect(verifyExportFieldReceipt({ ...receipt, fields: [] }).ok).toBe(false);
    expect(verifyExportFieldReceipt(null).ok).toBe(false);
  });

  it("retry path: identity is stable, and an injected clock keeps the digest stable", () => {
    const first = build();
    const retried = build();
    const nextClock = build({ now: () => NOW + 1 });
    const otherKey = build({ key: "export-key-456" });
    const otherActor = build({ actor: { kind: "user", id: "u-3" } });

    expect(retried.receiptId).toBe(first.receiptId);
    expect(retried.digest).toBe(first.digest);
    expect(nextClock.receiptId).toBe(first.receiptId);
    expect(nextClock.digest).not.toBe(first.digest);
    expect(otherKey.receiptId).not.toBe(first.receiptId);
    expect(otherActor.receiptId).not.toBe(first.receiptId);
  });

  it("authorization path: only owners and auditors see policy reasons", () => {
    const receipt = build();

    const owner = revealExportFieldReceipt(receipt, USER);
    expect(owner.ok).toBe(true);
    if (owner.ok) expect(owner.value.fields[0]?.reason).toBe("no rule");

    const maintainer = revealExportFieldReceipt(receipt, MAINTAINER);
    expect(maintainer.ok).toBe(true);
    if (maintainer.ok) expect(maintainer.value.fields[0]?.reason).toBe("no rule");

    const auditor = revealExportFieldReceipt(receipt, AUDIT_SERVICE);
    expect(auditor.ok).toBe(true);
    if (auditor.ok) expect(auditor.value.fields[0]?.reason).toBe("no rule");

    const stranger = revealExportFieldReceipt(receipt, OTHER_USER);
    expect(stranger.ok).toBe(true);
    if (stranger.ok) {
      expect(stranger.value.fields.every((field) => field.reason === "restricted")).toBe(true);
      expect(stranger.value.actorId).toBeUndefined();
      expect(stranger.value.fields.map((field) => field.action)).toEqual(
        receipt.fields.map((field) => field.action)
      );
    }

    const unprivilegedService = revealExportFieldReceipt(receipt, { kind: "service", id: "s-2" });
    expect(unprivilegedService.ok).toBe(true);
    if (unprivilegedService.ok) {
      expect(unprivilegedService.value.fields[0]?.reason).toBe("restricted");
    }
  });

  it("authorization path: revocation is owner/auditor only and remains verifiable", () => {
    const receipt = build();

    const denied = revokeExportFieldReceipt(receipt, OTHER_USER);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.code).toBe("export_receipt_unauthorized");

    const revoked = revokeExportFieldReceipt(receipt, USER);
    expect(revoked.ok).toBe(true);
    if (revoked.ok) {
      expect(revoked.value.revoked).toBe(true);
      expect(revoked.value.digest).toBe(receipt.digest);
      expect(verifyExportFieldReceipt(revoked.value).ok).toBe(true);
    }
  });

  it("edge path: expiry is explicit and revocation is advisory", () => {
    const receipt = build();

    expect(isExportFieldReceiptExpired(receipt, NOW + 999)).toBe(false);
    expect(isExportFieldReceiptExpired(receipt, NOW + 1_000)).toBe(true);
    expect(verifyExportFieldReceipt({ ...receipt, revoked: true }).ok).toBe(true);
  });
});
