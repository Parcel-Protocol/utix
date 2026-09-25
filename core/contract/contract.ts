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