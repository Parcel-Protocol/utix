import { describe, expect, it } from "vitest";
import {
  createImportedRecordProvenance,
  executeImportedRecordImport,
  verifyImportedRecordProvenance
} from "../imported-record";

describe("imported record provenance", () => {
  it("creates a deterministic digest and verifies a canonical record", () => {
    const provenance = createImportedRecordProvenance(
      { b: 2, a: 1 },
      "fixture",
      { importedAt: "2026-01-01T00:00:00.000Z" }
    );
    expect(provenance.ok).toBe(true);
    if (!provenance.ok) return;
    expect(provenance.value.recordDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(verifyImportedRecordProvenance({ a: 1, b: 2 }, provenance.value).value).toBe(true);
  });

  it("rejects a tampered record", () => {
    const provenance = createImportedRecordProvenance({ amount: "10" }, "fixture");
    if (!provenance.ok) return;
    expect(verifyImportedRecordProvenance({ amount: "11" }, provenance.value).value).toBe(false);
  });

  it("supports signatures and signature verification", () => {
    const signer = {
      signerId: "fixture-signing-key",
      sign: (payload: string) => `signed:${payload}`
    };
    const provenance = createImportedRecordProvenance({ id: "one" }, "fixture", { signer });
    if (!provenance.ok) return;
    expect(
      verifyImportedRecordProvenance({ id: "one" }, provenance.value, {
        verify: (payload, signature) => signature === `signed:${payload}`
      }).value
    ).toBe(true);
  });

  it("is idempotent for duplicate imports and authorizes privileged imports", () => {
    const first = executeImportedRecordImport({ id: "one" }, "fixture", { role: "maintainer" });
    const duplicate = executeImportedRecordImport({ id: "one" }, "fixture", { role: "maintainer" });
    expect(first.ok).toBe(true);
    expect(duplicate.ok).toBe(true);
    if (!first.ok || !duplicate.ok) return;
    expect(first.value.provenance.recordDigest).toBe(duplicate.value.provenance.recordDigest);

    expect(executeImportedRecordImport({ id: "one" }, "fixture", { role: "viewer" }).code).toBe(
      "provenance_permission_denied"
    );
  });

  it("rejects missing sources and malformed records", () => {
    expect(createImportedRecordProvenance({ id: "one" }, "").code).toBe("provenance_source_required");
    expect(createImportedRecordProvenance(undefined, "fixture").code).toBe("provenance_record_invalid");
  });
});
