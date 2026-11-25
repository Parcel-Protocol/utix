/**
 * Malformed payload fixtures for `WorkerFramework.submit()` (#333).
 *
 * Each case is one attack or mistake at the submit boundary and the violation
 * `validateJobInput` must report. Add a case here, not a one-off test, so the
 * corpus stays the single list of what the boundary refuses.
 */

import type { JobInput } from "@/core/workers/queue";
import type { JobInputViolation } from "@/core/workers/job-input";
import { MAX_JOB_PARAMS_BYTES, MAX_JOB_PARAMS_DEPTH } from "@/core/workers/job-input";

export interface MalformedSubmitFixture {
  readonly name: string;
  readonly input: JobInput;
  readonly violation: JobInputViolation;
}

function nested(depth: number): Record<string, unknown> {
  let value: Record<string, unknown> = { leaf: true };
  for (let i = 0; i < depth; i += 1) value = { next: value };
  return value;
}

const circular: Record<string, unknown> = { id: 1 };
circular.self = circular;

export const MALFORMED_SUBMIT_FIXTURES: readonly MalformedSubmitFixture[] = [
  // operation
  { name: "empty operation", input: { operation: "" }, violation: "invalid_operation" },
  { name: "operation with whitespace", input: { operation: "notify send" }, violation: "invalid_operation" },
  { name: "operation with a null byte", input: { operation: "notify.send\u0000" }, violation: "invalid_operation" },
  { name: "operation with a zero-width space", input: { operation: "notify​.send" }, violation: "invalid_operation" },
  { name: "operation with a homoglyph", input: { operation: "nоtify.send" }, violation: "invalid_operation" },
  { name: "operation that is too long", input: { operation: "a".repeat(129) }, violation: "invalid_operation" },
  { name: "operation that is not a string", input: { operation: 42 as unknown as string }, violation: "invalid_operation" },

  // retry budget
  { name: "NaN maxAttempts (never dead-letters)", input: { operation: "x.y", maxAttempts: Number.NaN }, violation: "invalid_max_attempts" },
  { name: "Infinity maxAttempts", input: { operation: "x.y", maxAttempts: Number.POSITIVE_INFINITY }, violation: "invalid_max_attempts" },
  { name: "zero maxAttempts", input: { operation: "x.y", maxAttempts: 0 }, violation: "invalid_max_attempts" },
  { name: "negative maxAttempts", input: { operation: "x.y", maxAttempts: -3 }, violation: "invalid_max_attempts" },
  { name: "fractional maxAttempts", input: { operation: "x.y", maxAttempts: 2.5 }, violation: "invalid_max_attempts" },
  { name: "absurd maxAttempts", input: { operation: "x.y", maxAttempts: 1_000_000 }, violation: "invalid_max_attempts" },

  // scheduling
  { name: "negative delay", input: { operation: "x.y", delayMs: -1 }, violation: "invalid_delay" },
  { name: "NaN delay", input: { operation: "x.y", delayMs: Number.NaN }, violation: "invalid_delay" },
  { name: "delay beyond 30 days", input: { operation: "x.y", delayMs: 31 * 24 * 60 * 60 * 1_000 }, violation: "invalid_delay" },

  // dedupe key
  { name: "empty dedupe key", input: { operation: "x.y", dedupeKey: "" }, violation: "invalid_dedupe_key" },
  { name: "dedupe key with a bidi override", input: { operation: "x.y", dedupeKey: "order-‮1" }, violation: "invalid_dedupe_key" },
  { name: "dedupe key with a newline", input: { operation: "x.y", dedupeKey: "a\nb" }, violation: "invalid_dedupe_key" },
  { name: "dedupe key that is too long", input: { operation: "x.y", dedupeKey: "k".repeat(257) }, violation: "invalid_dedupe_key" },

  // params shape
  { name: "params that is an array", input: { operation: "x.y", params: [] as unknown as Record<string, unknown> }, violation: "invalid_params" },
  { name: "params that is null", input: { operation: "x.y", params: null as unknown as Record<string, unknown> }, violation: "invalid_params" },
  { name: "params that is a Date", input: { operation: "x.y", params: new Date(0) as unknown as Record<string, unknown> }, violation: "invalid_params" },
  { name: "params with a function", input: { operation: "x.y", params: { run: () => 1 } }, violation: "invalid_params" },
  { name: "params with a bigint", input: { operation: "x.y", params: { amount: BigInt(1) } }, violation: "invalid_params" },
  { name: "params with undefined", input: { operation: "x.y", params: { memo: undefined } }, violation: "invalid_params" },
  { name: "params with NaN", input: { operation: "x.y", params: { amount: Number.NaN } }, violation: "invalid_params" },
  { name: "params with a Map", input: { operation: "x.y", params: { lookup: new Map() } }, violation: "invalid_params" },
  { name: "params with a cycle", input: { operation: "x.y", params: circular }, violation: "invalid_params" },
  { name: "params with a symbol key", input: { operation: "x.y", params: { [Symbol("s")]: 1 } as unknown as Record<string, unknown> }, violation: "invalid_params" },

  // prototype pollution
  { name: "own __proto__ key (as JSON.parse produces)", input: { operation: "x.y", params: JSON.parse('{"__proto__":{"isAdmin":true}}') as Record<string, unknown> }, violation: "forbidden_param_key" },
  { name: "nested constructor key", input: { operation: "x.y", params: { a: { constructor: { prototype: {} } } } }, violation: "forbidden_param_key" },
  { name: "prototype key inside an array", input: { operation: "x.y", params: { list: [{ prototype: 1 }] } }, violation: "forbidden_param_key" },

  // size
  { name: "params nested too deeply", input: { operation: "x.y", params: nested(MAX_JOB_PARAMS_DEPTH + 1) }, violation: "params_too_deep" },
  { name: "params over the size limit", input: { operation: "x.y", params: { blob: "A".repeat(MAX_JOB_PARAMS_BYTES) } }, violation: "params_too_large" },
  { name: "multi-byte params over the size limit", input: { operation: "x.y", params: { blob: "é".repeat(MAX_JOB_PARAMS_BYTES / 2) } }, violation: "params_too_large" }
];

/** Inputs right at the edge of every limit, which must still be accepted. */
export const BOUNDARY_SUBMIT_FIXTURES: readonly { readonly name: string; readonly input: JobInput }[] = [
  { name: "minimal input", input: { operation: "x" } },
  { name: "operation at 128 chars", input: { operation: "a".repeat(128) } },
  { name: "operation with namespace separators", input: { operation: "status.expire_service_mode:v2-beta" } },
  { name: "maxAttempts at 100", input: { operation: "x.y", maxAttempts: 100 } },
  { name: "zero delay", input: { operation: "x.y", delayMs: 0 } },
  { name: "dedupe key at 256 chars", input: { operation: "x.y", dedupeKey: "k".repeat(256) } },
  { name: "unicode in param values", input: { operation: "x.y", params: { memo: "café ☃", tags: ["a", "b"] } } },
  { name: "params at the depth limit", input: { operation: "x.y", params: nested(MAX_JOB_PARAMS_DEPTH - 1) } },
  { name: "shared (non-circular) reference", input: { operation: "x.y", params: (() => { const shared = { v: 1 }; return { a: shared, b: shared }; })() } }
];
