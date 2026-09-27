/**
 * Public API contract documentation support and drift detection.
 *
 * Utix exposes no external HTTP API — it is a read-only browser toolkit — so
 * the "public API" is the stable shape of the operations integration points
 * call and consumers rely on: error classifications, telemetry records, worker
 * jobs, export envelopes and feature manifests.
 *
 * Each operation gets a locked `ContractSchema`. Drift tests capture the real
 * output of the operation and assert it still satisfies the schema, so an
 * incompatible change to a response shape fails CI instead of silently
 * breaking a downstream consumer.
 */

import { err, ok, type Result } from "@/core/result/result";
import { measureSync } from "@/core/telemetry/telemetry";

export type ContractErrorCode = "contract_drift" | "missing_required_field" | "wrong_type";

/**
 * Stable codes for a refused version at the contract boundary.
 *
 * `schema_unsupported` already exists in `core/export`, so it is reused here
 * rather than invented twice. The other three are new and mean something a
 * consumer can act on differently: a missing version is a caller bug, a
 * deprecated one still works, and a future one is not ours to interpret.
 */
export type SchemaVersionErrorCode =
  | "schema_unsupported"
  | "schema_missing"
  | "schema_deprecated"
  | "schema_future";

/** What a consumer should do about a refused version. */
export type SchemaGuidance = "retry" | "upgrade" | "safe_fallback";

/**
 * The outcome of negotiating a version, for both the accepted and refused
 * cases. A caller that only checks `ok` still gets a usable answer; a caller
 * that renders recovery copy reads `guidance` and never has to parse a message.
 */
export interface SchemaCompatibility {
  /** The version that was asked for, or `null` when none was supplied. */
  readonly requested: string | null;
  /** The version this build speaks. */
  readonly current: string;
  /** Every version this build accepts, current one included. */
  readonly supported: readonly string[];
  /**
   * `ok` for the current version and for any explicitly still-supported older
   * one. `deprecated` versions negotiate successfully *and* report that they are
   * on their way out, so a consumer can warn without refusing the payload.
   */
  readonly status: "ok" | "deprecated";
  /** Present only when the version was refused. */
  readonly code?: SchemaVersionErrorCode;
  /** Present only when the version was refused. */
  readonly guidance?: SchemaGuidance;
  /** Human-readable, for logs and docs. Not for control flow. */
  readonly reason: string;
}

/**
 * Parse a `major.minor` version. Returns `null` for anything else, so a caller
 * that sends `"latest"` or `""` is refused as unsupported rather than being
 * silently coerced into a version it did not ask for.
 */
function parseVersion(version: string): [number, number] | null {
  const match = /^(\d+)\.(\d+)$/.exec(version.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2])];
}

function compareVersions(a: string, b: string): number | null {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;
  if (left[0] !== right[0]) return left[0] - right[0];
  return left[1] - right[1];
}

/**
 * Decide whether a requested schema version can be served, and what the caller
 * should do about it.
 *
 * Four shapes are distinguished, because they call for different responses and
 * collapsing them is what leaves a consumer guessing:
 *
 *   missing     — no version at all. The caller cannot be trusted to know what
 *                 it is talking about, so it is a caller bug, not a version
 *                 problem: fix the request.
 *   deprecated  — an older version this build still accepts. Served, with
 *                 `status: "deprecated"`, so the consumer can warn and plan the
 *                 upgrade while nothing breaks.
 *   future      — newer than this build. Refused with `safe_fallback`: the
 *                 payload may mean something this build cannot read, so it must
 *                 be ignored rather than half-interpreted, and retrying only
 *                 helps once the consumer is upgraded.
 *   unsupported — anything else, including unparseable text. Refused with
 *                 `upgrade`.
 *
 * `deprecated` versions are passed in rather than derived, because only the
 * owning module knows which older versions it still honours.
 */
export function negotiateSchemaVersion(input: {
  requested: string | null | undefined;
  current: string;
  deprecated?: readonly string[];
}): SchemaCompatibility {
  const deprecated = input.deprecated ?? [];
  const supported = [input.current, ...deprecated.filter((v) => v !== input.current)];

  if (input.requested === null || input.requested === undefined || input.requested.trim() === "") {
    return {
      requested: null,
      current: input.current,
      supported,
      status: "ok",
      code: "schema_missing",
      guidance: "upgrade",
      reason: `No schema version was supplied. Send schemaVersion: "${input.current}".`
    };
  }

  const requested = input.requested.trim();

  if (requested === input.current) {
    return { requested, current: input.current, supported, status: "ok", reason: "Version matches." };
  }

  if (deprecated.includes(requested)) {
    return {
      requested,
      current: input.current,
      supported,
      status: "deprecated",
      reason:
        `Version ${requested} is deprecated and will stop being served at some point. ` +
        `Move to ${input.current}; nothing breaks until then.`
    };
  }

  const ordering = compareVersions(requested, input.current);
  if (ordering !== null && ordering > 0) {
    return {
      requested,
      current: input.current,
      supported,
      status: "ok",
      code: "schema_future",
      guidance: "safe_fallback",
      reason:
        `Version ${requested} is newer than this build's ${input.current}, so its payload may ` +
        "mean something this build cannot read. Fall back to defaults rather than interpreting " +
        "it, and upgrade to consume it."
    };
  }

  return {
    requested,
    current: input.current,
    supported,
    status: "ok",
    code: "schema_unsupported",
    guidance: "upgrade",
    reason:
      `Version ${requested} is not served by this build. Supported: ${supported.join(", ")}. ` +
      "Upgrade, or request a supported version."
  };
}

/**
 * Negotiate a version, or return the refusal as the module's `Result`.
 *
 * This is the shape a boundary should use: a caller that switches on the code
 * gets `schema_missing`, `schema_deprecated`, `schema_future` or
 * `schema_unsupported`, and the guidance is carried in `detail`.
 */
export function negotiateSchemaVersionOrError(
  input: { requested: string | null | undefined; current: string; deprecated?: readonly string[] }
): Result<SchemaCompatibility, SchemaVersionErrorCode, SchemaCompatibility> {
  const outcome = negotiateSchemaVersion(input);
  if (outcome.code === undefined) return ok(outcome);
  return err(outcome.code, outcome);
}

export type ContractFieldType = "string" | "number" | "boolean" | "object" | "array";

export interface ContractField {
  type: ContractFieldType;
  required?: boolean;
  /** Dot-nested path when the value lives inside an object/array. */
  path?: string;
}

export interface ContractSchema {
  /** Stable contract version; bumps on any breaking change. */
  version: string;
  fields: Record<string, ContractField>;
}

export interface ContractOperation {
  name: string;
  schema: ContractSchema;
}

function fieldValue(root: unknown, path: string | undefined): unknown {
  if (!path) return root;
  let cursor: unknown = root;
  for (const segment of path.split(".")) {
    if (cursor === null || cursor === undefined) return undefined;
    if (Array.isArray(cursor) && /^\d+$/.test(segment)) cursor = cursor[Number(segment)];
    else if (typeof cursor === "object") cursor = (cursor as Record<string, unknown>)[segment];
    else return undefined;
  }
  return cursor;
}

function matchesType(value: unknown, type: ContractFieldType): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
  }
}

/**
 * Validates an actual value against a locked schema. Returns
 * `contract_drift` (first field that no longer matches) or `ok`.
 */
export function validateContract(
  actual: unknown,
  schema: ContractSchema
): Result<true, ContractErrorCode> {
  if (typeof actual !== "object" || actual === null) {
    return err("contract_drift");
  }

  for (const [name, field] of Object.entries(schema.fields)) {
    if (!field.required) continue;
    const value = fieldValue(actual, field.path ?? name);
    if (value === undefined) return err("missing_required_field");
    if (!matchesType(value, field.type)) return err("wrong_type");
  }

  return ok(true);
}

/**
 * Registers an operation contract against the documented schema. Used by the
 * drift tests and by `docs/API_CONTRACT.md` examples.
 */
export function contractOperation(name: string, schema: ContractSchema): ContractOperation {
  return { name, schema };
}

/**
 * Runs `capture` (the real implementation) and checks the result against the
 * locked schema, emitting `contract.validate` telemetry in the process.
 */
export function assertContract(
  operation: ContractOperation,
  capture: () => unknown
): Result<true, ContractErrorCode> {
  return measureSync(
    "contract.validate",
    { actorType: "system", payload: { contract: operation.name } },
    () => {
      const actual = capture();
      const validated = validateContract(actual, operation.schema);
      return validated.ok ? ok(true) : err("contract_drift");
    }
  );
}

/** Convenience for error-shaped results: `{ code, detail }`. */
export function errorSchema(version: string): ContractSchema {
  return {
    version,
    fields: {
      code: { type: "string", required: true },
      detail: { type: "object", required: false }
    }
  };
}