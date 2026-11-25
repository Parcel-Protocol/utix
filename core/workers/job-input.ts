/**
 * Boundary validation for `WorkerFramework.submit()` (#333).
 *
 * `submit()` is the high-risk write path: its input can come from a URL, a
 * form or another tab. Before this check it was trusted as-is, so:
 *
 * - `maxAttempts: NaN` (or `Infinity`) never dead-lettered, because
 *   `attempts >= NaN` is always false: the job retried forever;
 * - `params` could carry `__proto__` / `constructor` keys, functions, cycles
 *   or megabytes of data straight into the queue and the idempotency digest;
 * - `operation` and `dedupeKey` could hold control or invisible characters
 *   that make two jobs look identical in logs while hashing differently.
 *
 * `validateJobInput` refuses all of these with one stable code and a reason.
 * It never rewrites input: a half-sanitised payload is harder to reason about
 * than a refused one. `enqueue()` stays the trusted internal path.
 */

import type { JobInput } from "./queue";

export const JOB_OPERATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
export const MAX_JOB_ATTEMPTS = 100;
export const MAX_JOB_DELAY_MS = 30 * 24 * 60 * 60 * 1_000;
export const MAX_JOB_PARAMS_BYTES = 64 * 1_024;
export const MAX_JOB_PARAMS_DEPTH = 16;
export const MAX_DEDUPE_KEY_LENGTH = 256;

export type JobInputViolation =
  | "invalid_operation"
  | "invalid_max_attempts"
  | "invalid_delay"
  | "invalid_params"
  | "forbidden_param_key"
  | "params_too_deep"
  | "params_too_large"
  | "invalid_dedupe_key";

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** C0/C1 controls, zero-width characters, bidi overrides and the BOM. */
function hasUnsafeChar(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (
      code <= 0x1f ||
      (code >= 0x7f && code <= 0x9f) ||
      (code >= 0x200b && code <= 0x200f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2060 && code <= 0x2064) ||
      code === 0xfeff
    ) {
      return true;
    }
  }
  return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/** Walks `value` depth-first; returns the first violation, or null. */
function inspectValue(value: unknown, depth: number, seen: Set<object>): JobInputViolation | null {
  if (depth > MAX_JOB_PARAMS_DEPTH) return "params_too_deep";
  if (value === null) return null;
  switch (typeof value) {
    case "string":
    case "boolean":
      return null;
    case "number":
      return Number.isFinite(value) ? null : "invalid_params";
    case "object": {
      if (seen.has(value)) return "invalid_params";
      seen.add(value);
      if (Array.isArray(value)) {
        for (const item of value) {
          const violation = inspectValue(item, depth + 1, seen);
          if (violation) return violation;
        }
      } else if (isPlainObject(value)) {
        for (const key of Reflect.ownKeys(value)) {
          if (typeof key !== "string") return "invalid_params";
          if (FORBIDDEN_KEYS.has(key)) return "forbidden_param_key";
          const violation = inspectValue((value as Record<string, unknown>)[key], depth + 1, seen);
          if (violation) return violation;
        }
      } else {
        // Dates, Maps, class instances: not plain data, and not stable to hash.
        return "invalid_params";
      }
      seen.delete(value);
      return null;
    }
    default:
      // undefined, function, symbol, bigint
      return "invalid_params";
  }
}

/** Returns the first problem with `input`, or null when it may be submitted. */
export function validateJobInput(input: JobInput): JobInputViolation | null {
  if (typeof input.operation !== "string" || !JOB_OPERATION_PATTERN.test(input.operation)) {
    return "invalid_operation";
  }
  if (
    input.maxAttempts !== undefined &&
    (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1 || input.maxAttempts > MAX_JOB_ATTEMPTS)
  ) {
    return "invalid_max_attempts";
  }
  if (
    input.delayMs !== undefined &&
    (!Number.isFinite(input.delayMs) || input.delayMs < 0 || input.delayMs > MAX_JOB_DELAY_MS)
  ) {
    return "invalid_delay";
  }
  if (input.dedupeKey !== undefined) {
    if (
      typeof input.dedupeKey !== "string" ||
      input.dedupeKey.length === 0 ||
      input.dedupeKey.length > MAX_DEDUPE_KEY_LENGTH ||
      hasUnsafeChar(input.dedupeKey)
    ) {
      return "invalid_dedupe_key";
    }
  }
  if (input.params !== undefined) {
    if (!isPlainObject(input.params)) return "invalid_params";
    const violation = inspectValue(input.params, 0, new Set());
    if (violation) return violation;
    if (new TextEncoder().encode(JSON.stringify(input.params)).length > MAX_JOB_PARAMS_BYTES) {
      return "params_too_large";
    }
  }
  return null;
}
