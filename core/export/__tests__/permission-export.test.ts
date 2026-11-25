/**
 * Tests for permission-aware export with field redaction (#331).
 */

import { describe, expect, it } from "vitest";
import {
  buildFieldPolicy,
  decideField,
  applyFieldPolicy,
  redactRecord,
  redactRecords,
  actorScope,
  MASK_PLACEHOLDER,
  type FieldPolicy,
} from "../permission-export";
import type { ExportActor, FieldAuthorizationRule } from "../exporter";

const user: ExportActor = { kind: "user" };
const maintainer: ExportActor = { kind: "maintainer" };
const service: ExportActor = { kind: "service" };

const sampleRecord = {
  id: "tx-001",
  amount: "150.00",
  status: "settled",
  ipAddress: "203.0.113.1",
  userAgent: "Chrome/120",
  internalLatencyMs: 45,
  adminNotes: "High value",
  riskScore: 0.5,
  debugTrace: "stack...",
};

// ─────────────────────────────────────────────────────────────────────────────
// actorScope
// ─────────────────────────────────────────────────────────────────────────────

describe("actorScope (#331)", () => {
  it("user → own", () => expect(actorScope(user)).toBe("own"));
  it("maintainer → maintainer", () => expect(actorScope(maintainer)).toBe("maintainer"));
  it("service → maintainer", () => expect(actorScope(service)).toBe("maintainer"));
});

// ─────────────────────────────────────────────────────────────────────────────
// decideField
// ─────────────────────────────────────────────────────────────────────────────

describe("decideField (#331)", () => {
  it("allows fields that have no rule", () => {
    const policy = buildFieldPolicy(user, "own");
    expect(decideField("amount", policy).action).toBe("allow");
    expect(decideField("id", policy).action).toBe("allow");
  });

  it("omits maintainer-only fields for a user (default onDenied)", () => {
    const policy = buildFieldPolicy(user, "own");
    expect(decideField("debugTrace", policy).action).toBe("omit");
    expect(decideField("internalLatencyMs", policy).action).toBe("omit");
  });

  it("masks fields with onDenied: mask for a user", () => {
    const policy = buildFieldPolicy(user, "own");
    expect(decideField("ipAddress", policy).action).toBe("mask");
    expect(decideField("adminNotes", policy).action).toBe("mask");
  });

  it("allows all sensitive fields for a maintainer", () => {
    const policy = buildFieldPolicy(maintainer, "maintainer");
    for (const field of ["ipAddress", "internalLatencyMs", "adminNotes", "riskScore", "debugTrace"]) {
      expect(decideField(field, policy).action).toBe("allow");
    }
  });

  it("allows all sensitive fields for a service actor", () => {
    const policy = buildFieldPolicy(service, "maintainer");
    expect(decideField("riskScore", policy).action).toBe("allow");
  });

  it("user with the required permission is allowed through a permission rule", () => {
    const extraRules: FieldAuthorizationRule[] = [
      { field: "secretReport", minScope: "maintainer", requiredPermissions: ["audit:read"], onDenied: "omit" },
    ];
    const noPermPolicy = buildFieldPolicy({ kind: "user", permissions: [] }, "own", extraRules);
    const withPermPolicy = buildFieldPolicy({ kind: "user", permissions: ["audit:read"] }, "own", extraRules);
    expect(decideField("secretReport", noPermPolicy).action).toBe("omit");
    expect(decideField("secretReport", withPermPolicy).action).toBe("allow");
  });

  it("error onDenied is passed through", () => {
    const extraRules: FieldAuthorizationRule[] = [
      { field: "pciData", minScope: "maintainer", onDenied: "error" },
    ];
    const policy = buildFieldPolicy(user, "own", extraRules);
    expect(decideField("pciData", policy).action).toBe("error");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// applyFieldPolicy
// ─────────────────────────────────────────────────────────────────────────────

describe("applyFieldPolicy (#331)", () => {
  it("user export: omits debugTrace, masks ipAddress and adminNotes", () => {
    const policy = buildFieldPolicy(user, "own");
    const result = applyFieldPolicy(sampleRecord, policy);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect("debugTrace" in result.record).toBe(false);
    expect("userAgent" in result.record).toBe(false);
    expect(result.record["ipAddress"]).toBe(MASK_PLACEHOLDER);
    expect(result.record["adminNotes"]).toBe(MASK_PLACEHOLDER);
    expect(result.record["id"]).toBe("tx-001");
    expect(result.record["amount"]).toBe("150.00");
    expect(result.redactedFields).toContain("ipAddress");
    expect(result.redactedFields).toContain("debugTrace");
  });

  it("maintainer export: all fields pass through", () => {
    const policy = buildFieldPolicy(maintainer, "maintainer");
    const result = applyFieldPolicy(sampleRecord, policy);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record["ipAddress"]).toBe("203.0.113.1");
    expect(result.record["adminNotes"]).toBe("High value");
    expect(result.record["riskScore"]).toBe(0.5);
    expect(result.redactedFields).toHaveLength(0);
  });

  it("does not mutate the original record", () => {
    const original = { id: "x", adminNotes: "note", amount: "100" };
    const policy = buildFieldPolicy(user, "own");
    applyFieldPolicy(original, policy);
    expect(original).toEqual({ id: "x", adminNotes: "note", amount: "100" });
  });

  it("stops and returns ok:false on error onDenied", () => {
    const extraRules: FieldAuthorizationRule[] = [
      { field: "pciData", minScope: "maintainer", onDenied: "error" },
    ];
    const policy = buildFieldPolicy(user, "own", extraRules);
    const result = applyFieldPolicy({ id: "x", pciData: "4111..." }, policy);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorField).toBe("pciData");
  });

  it("extra rules override defaults for the same field", () => {
    // Override ipAddress (default: mask) to omit instead.
    const extraRules: FieldAuthorizationRule[] = [
      { field: "ipAddress", minScope: "maintainer", onDenied: "omit" },
    ];
    const policy = buildFieldPolicy(user, "own", extraRules);
    const result = applyFieldPolicy({ ipAddress: "1.2.3.4" }, policy);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect("ipAddress" in result.record).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// redactRecord (one-shot helper)
// ─────────────────────────────────────────────────────────────────────────────

describe("redactRecord (#331)", () => {
  it("user gets sensitive fields removed or masked", () => {
    const result = redactRecord(sampleRecord, user, "own");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect("debugTrace" in result.record).toBe(false);
    expect(result.record["ipAddress"]).toBe(MASK_PLACEHOLDER);
  });

  it("maintainer gets full record", () => {
    const result = redactRecord(sampleRecord, maintainer, "maintainer");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.redactedFields).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// redactRecords (batch)
// ─────────────────────────────────────────────────────────────────────────────

describe("redactRecords (#331)", () => {
  it("processes all records for a user", () => {
    const records = [sampleRecord, { id: "tx-002", amount: "5.00", ipAddress: "10.0.0.1" }];
    const result = redactRecords(records, user, "own");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.records).toHaveLength(2);
    expect(result.records[1]?.record["ipAddress"]).toBe(MASK_PLACEHOLDER);
  });

  it("stops at the first error field and reports index", () => {
    const extraRules: FieldAuthorizationRule[] = [
      { field: "pciData", minScope: "maintainer", onDenied: "error" },
    ];
    const records = [
      { id: "a", amount: "10" },
      { id: "b", pciData: "4111...", amount: "20" },
      { id: "c", amount: "30" },
    ];
    const result = redactRecords(records, user, "own", extraRules);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.index).toBe(1);
    expect(result.errorField).toBe("pciData");
  });

  it("empty array is fine", () => {
    const result = redactRecords([], user, "own");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.records).toHaveLength(0);
  });
});
