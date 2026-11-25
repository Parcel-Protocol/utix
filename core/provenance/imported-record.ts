import { sha256Hex } from "@/core/ledger/sha256";
import type { AuthContext } from "@/core/auth/middleware";
import { hasPermission } from "@/core/auth/types";
import { err, ok, type Result } from "@/core/result/result";

export type ImportedRecordProvenanceError =
  | "provenance_source_required"
  | "provenance_record_invalid"
  | "provenance_signature_invalid"
  | "provenance_permission_denied";

export interface ImportProvenanceSigner {
  readonly signerId: string;
  sign(payload: string): string;
}

export interface ImportProvenanceVerifier {
  verify(payload: string, signature: string): boolean;
}

export interface ImportedRecordProvenance {
  readonly schemaVersion: "1.0";
  readonly source: string;
  readonly importedAt: string;
  readonly recordDigest: string;
  readonly algorithm: "SHA-256";
  readonly signature?: {
    readonly signerId: string;
    readonly value: string;
  };
}

export interface ProvenanceEnvelope<T> {
  readonly record: T;
  readonly provenance: ImportedRecordProvenance;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function canonicalImportedRecord(record: unknown): string {
  return canonical(record);
}

export function createImportedRecordProvenance(
  record: unknown,
  source: string,
  options: {
    readonly importedAt?: string;
    readonly signer?: ImportProvenanceSigner;
  } = {}
): Result<ImportedRecordProvenance, ImportedRecordProvenanceError> {
  if (!source.trim()) return err("provenance_source_required");
  if (record === null || record === undefined || typeof record === "function") {
    return err("provenance_record_invalid");
  }

  let canonicalRecord: string;
  try {
    canonicalRecord = canonicalImportedRecord(record);
  } catch {
    return err("provenance_record_invalid");
  }

  const provenance: ImportedRecordProvenance = {
    schemaVersion: "1.0",
    source: source.trim(),
    importedAt: options.importedAt ?? new Date().toISOString(),
    recordDigest: sha256Hex(canonicalRecord),
    algorithm: "SHA-256",
    ...(options.signer
      ? {
          signature: {
            signerId: options.signer.signerId,
            value: options.signer.sign(`${source.trim()}:${sha256Hex(canonicalRecord)}`)
          }
        }
      : {})
  };
  return ok(provenance);
}

export function verifyImportedRecordProvenance(
  record: unknown,
  provenance: ImportedRecordProvenance,
  verifier?: ImportProvenanceVerifier
): Result<boolean, ImportedRecordProvenanceError> {
  if (provenance.algorithm !== "SHA-256" || provenance.recordDigest.length !== 64) {
    return err("provenance_signature_invalid");
  }
  const expected = sha256Hex(canonicalImportedRecord(record));
  if (provenance.recordDigest !== expected) return ok(false);
  if (!provenance.signature) return ok(true);
  if (!verifier) return err("provenance_signature_invalid");
  const payload = `${provenance.source}:${expected}`;
  return ok(verifier.verify(payload, provenance.signature.value));
}

export function executeImportedRecordImport<T>(
  record: T,
  source: string,
  auth: AuthContext,
  signer?: ImportProvenanceSigner
): Result<ProvenanceEnvelope<T>, ImportedRecordProvenanceError> {
  if (!hasPermission(auth.role, "admin:recovery")) {
    return err("provenance_permission_denied");
  }
  const provenance = createImportedRecordProvenance(record, source, { signer });
  if (!provenance.ok) return provenance;
  return ok({ record, provenance: provenance.value });
}
