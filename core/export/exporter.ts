/**
 * Privacy-safe data export workflow.
 *
 * Exports are scoped, schema-versioned and time-limited. A consumer requests a
 * schema version and an authorization scope; the exporter only ever yields
 * records the caller is allowed to see, tags the envelope with generation
 * metadata, redacts secret-shaped values, and stamps an expiry so generated
 * artifacts do not live forever.
 *
 * This module is pure and synchronous: collectable sources are passed in, so
 * the workflow is unit-testable without a store.
 */

import { err, ok, type Result } from "@/core/result/result";
import {
  emitTelemetry,
  measureSync,
  newCorrelationId,
  redact
} from "@/core/telemetry/telemetry";

export type ExportErrorCode =
  | "export_denied"
  | "schema_unsupported"
  | "empty_source"
  | "unsupported_scope";

/** Increment on any breaking change to record shapes or the envelope. */
export const EXPORT_CURRENT_SCHEMA_VERSION = "1.0";

export const EXPORT_GENERATOR = "utix-export@1";

/** Default retention for a generated export artifact. */
export const EXPORT_DEFAULT_TTL_MS = 24 * 60 * 60 * 1_000;

export type ExportScope = "own" | "maintainer";

/** Who is asking. Only maintainers may request the `maintainer` scope. */
export type ExportActor =
  | { kind: "user" }
  | { kind: "maintainer"; token?: string };

export interface ExportRecordSource {
  /** Stable identifier, e.g. `operation_log`. */
  recordType: string;
  /** The schema version this source produces. */
  schemaVersion: string;
  /** Which scope the source's records belong to. */
  scope: ExportScope;
  /** Collects the records synchronously. May include sensitive-looking fields. */
  collect: () => ExportRecord[];
}

export type ExportRecord = Record<string, unknown>;

export interface ExportRequest {
  schemaVersion: string;
  scope: ExportScope;
  actor: ExportActor;
  /** Optional generation correlation id to thread through. */
  correlationId?: string;
  /** Retention override in ms; defaults to `EXPORT_DEFAULT_TTL_MS`. */
  ttlMs?: number;
  /** Optional pagination: how many records per page. */
  pageSize?: number;
  page?: number;
}

export interface ExportEnvelope {
  schemaVersion: string;
  scope: ExportScope;
  generatedAt: string;
  expiresAt: string;
  generator: string;
  correlationId: string;
  recordCount: number;
  page: number;
  totalRecords: number;
  records: ExportRecord[];
}

export type ExportResult = Result<ExportEnvelope, ExportErrorCode>;

function nowIso(): string {
  return new Date().toISOString();
}

function authScope(actor: ExportActor): ExportScope {
  return actor.kind === "maintainer" ? "maintainer" : "own";
}

/** Authorization gate: a request must not out-scope its actor. */
export function authorizeExport(
  actor: ExportActor,
  requestedScope: ExportScope
): Result<ExportScope, "export_denied"> {
  if (requestedScope === "maintainer" && authScope(actor) !== "maintainer") {
    return err("export_denied");
  }
  return ok(authScope(actor));
}

/**
 * Generates a scoped, versioned export from the given sources.
 *
 * Records are filtered to the requested scope, sensitive-shaped fields are
 * redacted, and the envelope carries generation metadata plus an expiry.
 */
export function exportRecords(
  request: ExportRequest,
  sources: ExportRecordSource[]
): ExportResult {
  return measureSync(
    "export.generate",
    { actorType: "user", correlationId: request.correlationId },
    () => {
      const authorization = authorizeExport(request.actor, request.scope);
      if (!authorization.ok) {
        emitTelemetry({
          op: "export.authorize",
          actorType: "user",
          result: "failure",
          correlationId: request.correlationId ?? newCorrelationId(),
          errorCode: "export_denied"
        });
        return authorization;
      }

      if (request.schemaVersion !== EXPORT_CURRENT_SCHEMA_VERSION) {
        return err("schema_unsupported");
      }

      const allowed = sources.filter(
        (source) =>
          source.schemaVersion === request.schemaVersion &&
          (request.scope === "maintainer" || source.scope === "own")
      );

      const collected = allowed.flatMap((source) =>
        source
          .collect()
          .map((record) => ({
            ...record,
            recordType: source.recordType,
            scope: source.scope
          }))
      );

      const ttlMs = request.ttlMs ?? EXPORT_DEFAULT_TTL_MS;
      const pageSize = request.pageSize ?? (collected.length > 0 ? collected.length : 1);
      const page = request.page ?? 1;
      const start = (page - 1) * pageSize;
      const paged = collected.slice(start, start + pageSize);
      const totalRecords = collected.length;

      const envelope: ExportEnvelope = {
        schemaVersion: request.schemaVersion,
        scope: request.scope,
        generatedAt: nowIso(),
        expiresAt: new Date(Date.now() + ttlMs).toISOString(),
        generator: EXPORT_GENERATOR,
        correlationId: request.correlationId ?? newCorrelationId(),
        recordCount: paged.length,
        page,
        totalRecords,
        records: paged.map((record) => redact(record) as ExportRecord)
      };

      return ok(envelope);
    }
  );
}

/** True once an export's retention window has elapsed. */
export function isExportExpired(envelope: ExportEnvelope, now: number = Date.now()): boolean {
  return now > Date.parse(envelope.expiresAt);
}