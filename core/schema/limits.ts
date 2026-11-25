/**
 * Strict Input Size and Cardinality Limits Engine (#365).
 *
 * Implements strict boundary defenses preventing memory exhaustion, JSON/AST bombs,
 * prototype pollution, and unbounded cardinality across Utix parsers, feature slices,
 * exports, and integration inputs:
 *
 * - Payload size bounds: max byte ceiling enforced (default 256 KB, aligns with threat model).
 * - Cardinality bounds: max array elements and object keys (preventing unbounded collections).
 * - Structural depth bounds: max AST/JSON nesting depth (default 16, preventing stack overflow).
 * - Prototype pollution defense: blocks '__proto__', 'constructor', 'prototype' keys.
 * - Graceful truncation & slicing: sanitizes or slices oversized inputs for retry recovery.
 * - Authorization: maintainer-only elevated limits up to hard safety ceiling (2 MB).
 * - Time & Space complexity:
 *     - Time Complexity: O(N) where N is the total byte size / node count of the input.
 *     - Space Complexity: O(D) where D is max recursion depth (strictly bounded, D <= 16).
 */

import { recordAudit } from "@/core/audit/audit";
import { err, ok, type Result } from "@/core/result/result";
import { measureSync, newCorrelationId } from "@/core/telemetry/telemetry";

export const DEFAULT_MAX_PAYLOAD_BYTES = 256 * 1024; // 256 KB
export const DEFAULT_MAX_STRING_LENGTH = 64 * 1024; // 64 KB
export const DEFAULT_MAX_COLLECTION_SIZE = 500; // 500 items
export const DEFAULT_MAX_OBJECT_KEYS = 100; // 100 keys
export const DEFAULT_MAX_DEPTH = 16; // 16 nesting levels
export const HARD_CEILING_MAX_BYTES = 2 * 1024 * 1024; // 2 MB maintainer cap

export const DISALLOWED_KEYS: readonly string[] = Object.freeze([
  "__proto__",
  "constructor",
  "prototype"
]);

export type InputLimitErrorCode =
  | "payload_too_large"
  | "string_too_long"
  | "cardinality_exceeded"
  | "object_key_limit_exceeded"
  | "nesting_depth_exceeded"
  | "disallowed_key_detected"
  | "unauthorized_override"
  | "invalid_input";

export interface InputValidationDetails {
  readonly limitType: string;
  readonly actual: number | string;
  readonly maximum: number;
  readonly path?: string;
  readonly remediation: string;
}

export interface InputLimitPolicy {
  readonly maxBytes?: number;
  readonly maxStringLength?: number;
  readonly maxCollectionSize?: number;
  readonly maxObjectKeys?: number;
  readonly maxDepth?: number;
  readonly disallowedKeys?: readonly string[];
}

export interface InputSanitizationResult<T> {
  readonly sanitized: T;
  readonly truncated: boolean;
  readonly droppedItemsCount: number;
  readonly truncatedStringsCount: number;
}

export interface SlicingSuggestion {
  readonly recommendedBatchSize: number;
  readonly totalChunks: number;
}

export class StrictInputLimiter {
  /**
   * Enforces strict size, cardinality, depth, and safety limits on untrusted input.
   * O(N) time complexity, O(D) stack space strictly bounded to maxDepth.
   */
  public enforceLimits<T>(
    input: unknown,
    policy: InputLimitPolicy = {},
    auth?: { actor: { kind: string; id: string } }
  ): Result<T, InputLimitErrorCode, InputValidationDetails> {
    const maxBytes = policy.maxBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
    const maxStringLength = policy.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH;
    const maxCollectionSize = policy.maxCollectionSize ?? DEFAULT_MAX_COLLECTION_SIZE;
    const maxObjectKeys = policy.maxObjectKeys ?? DEFAULT_MAX_OBJECT_KEYS;
    const maxDepth = policy.maxDepth ?? DEFAULT_MAX_DEPTH;
    const disallowedKeys = policy.disallowedKeys ?? DISALLOWED_KEYS;

    // 1. Authorization Path: Elevated limits require maintainer privileges
    if (maxBytes > DEFAULT_MAX_PAYLOAD_BYTES || maxCollectionSize > DEFAULT_MAX_COLLECTION_SIZE) {
      if (!auth || auth.actor.kind !== "maintainer") {
        return err("unauthorized_override", {
          limitType: "override_authorization",
          actual: auth?.actor.kind ?? "anonymous",
          maximum: 0,
          remediation: "Only authorized maintainers can relax input size or cardinality limits"
        });
      }
      if (maxBytes > HARD_CEILING_MAX_BYTES) {
        return err("payload_too_large", {
          limitType: "hard_ceiling_bytes",
          actual: maxBytes,
          maximum: HARD_CEILING_MAX_BYTES,
          remediation: `Limit exceeds absolute system ceiling of ${HARD_CEILING_MAX_BYTES} bytes`
        });
      }
    }

    if (input === undefined || input === null) {
      return ok(input as T);
    }

    // 2. Global byte size check for string / JSON inputs
    if (typeof input === "string") {
      const byteLen = Buffer.byteLength(input, "utf8");
      if (byteLen > maxBytes) {
        return err("payload_too_large", {
          limitType: "payload_bytes",
          actual: byteLen,
          maximum: maxBytes,
          remediation: `Payload size (${byteLen} bytes) exceeds limit of ${maxBytes} bytes`
        });
      }
      if (input.length > maxStringLength) {
        return err("string_too_long", {
          limitType: "string_length",
          actual: input.length,
          maximum: maxStringLength,
          remediation: `String length exceeds maximum allowed (${maxStringLength})`
        });
      }
      return ok(input as T);
    }

    // 3. Recursive inspection for structured collections
    const visited = new WeakSet<object>();
    let totalBytesEstimate = 0;

    const traverse = (
      node: unknown,
      currentDepth: number,
      path: string
    ): Result<true, InputLimitErrorCode, InputValidationDetails> => {
      if (currentDepth > maxDepth) {
        return err("nesting_depth_exceeded", {
          limitType: "nesting_depth",
          actual: currentDepth,
          maximum: maxDepth,
          path,
          remediation: `Data nesting depth exceeds maximum allowed (${maxDepth})`
        });
      }

      if (node === null || node === undefined) {
        return ok(true);
      }

      if (typeof node === "string") {
        const len = node.length;
        totalBytesEstimate += len;
        if (totalBytesEstimate > maxBytes) {
          return err("payload_too_large", {
            limitType: "payload_bytes",
            actual: totalBytesEstimate,
            maximum: maxBytes,
            path,
            remediation: `Aggregated payload exceeds maximum allowed (${maxBytes} bytes)`
          });
        }
        if (len > maxStringLength) {
          return err("string_too_long", {
            limitType: "string_length",
            actual: len,
            maximum: maxStringLength,
            path,
            remediation: `String at path '${path}' exceeds limit of ${maxStringLength}`
          });
        }
        return ok(true);
      }

      if (typeof node === "number" || typeof node === "boolean") {
        totalBytesEstimate += 8;
        return ok(true);
      }

      if (typeof node === "object") {
        if (visited.has(node)) {
          // Circular reference protection
          return err("invalid_input", {
            limitType: "circular_reference",
            actual: "cycle_detected",
            maximum: 0,
            path,
            remediation: "Circular reference detected in input payload"
          });
        }
        visited.add(node);

        if (Array.isArray(node)) {
          if (node.length > maxCollectionSize) {
            return err("cardinality_exceeded", {
              limitType: "collection_size",
              actual: node.length,
              maximum: maxCollectionSize,
              path,
              remediation: `Array cardinality (${node.length}) exceeds maximum limit (${maxCollectionSize})`
            });
          }

          for (let i = 0; i < node.length; i++) {
            const itemRes = traverse(node[i], currentDepth + 1, `${path}[${i}]`);
            if (!itemRes.ok) return itemRes;
          }
          return ok(true);
        }

        const keys = Object.keys(node);
        if (keys.length > maxObjectKeys) {
          return err("object_key_limit_exceeded", {
            limitType: "object_keys",
            actual: keys.length,
            maximum: maxObjectKeys,
            path,
            remediation: `Object has ${keys.length} keys, exceeding limit of ${maxObjectKeys}`
          });
        }

        for (const key of keys) {
          if (disallowedKeys.includes(key)) {
            return err("disallowed_key_detected", {
              limitType: "prototype_security",
              actual: key,
              maximum: 0,
              path: path ? `${path}.${key}` : key,
              remediation: `Forbidden prototype property '${key}' detected`
            });
          }

          const propRes = traverse(
            (node as Record<string, unknown>)[key],
            currentDepth + 1,
            path ? `${path}.${key}` : key
          );
          if (!propRes.ok) return propRes;
        }

        return ok(true);
      }

      return ok(true);
    };

    const validation = traverse(input, 1, "root");
    if (!validation.ok) {
      return validation;
    }

    return ok(input as T);
  }

  /**
   * Retry & Recovery Path: Truncates oversized collections and strings gracefully
   * to fit within limits, returning the sanitized payload and statistics.
   */
  public sanitizeOrTruncate<T>(input: unknown, policy: InputLimitPolicy = {}): InputSanitizationResult<T> {
    const maxStringLength = policy.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH;
    const maxCollectionSize = policy.maxCollectionSize ?? DEFAULT_MAX_COLLECTION_SIZE;
    const maxObjectKeys = policy.maxObjectKeys ?? DEFAULT_MAX_OBJECT_KEYS;
    const maxDepth = policy.maxDepth ?? DEFAULT_MAX_DEPTH;

    let truncated = false;
    let droppedItemsCount = 0;
    let truncatedStringsCount = 0;

    const sanitizeNode = (node: unknown, depth: number): unknown => {
      if (depth > maxDepth) {
        truncated = true;
        return "[DEPTH_TRUNCATED]";
      }

      if (node === null || node === undefined) {
        return node;
      }

      if (typeof node === "string") {
        if (node.length > maxStringLength) {
          truncated = true;
          truncatedStringsCount += 1;
          return `${node.slice(0, maxStringLength)}...[TRUNCATED]`;
        }
        return node;
      }

      if (Array.isArray(node)) {
        if (node.length > maxCollectionSize) {
          truncated = true;
          droppedItemsCount += node.length - maxCollectionSize;
          return node.slice(0, maxCollectionSize).map((item) => sanitizeNode(item, depth + 1));
        }
        return node.map((item) => sanitizeNode(item, depth + 1));
      }

      if (typeof node === "object") {
        const out: Record<string, unknown> = {};
        const keys = Object.keys(node).filter((k) => !DISALLOWED_KEYS.includes(k));
        const limitedKeys = keys.slice(0, maxObjectKeys);

        if (keys.length > maxObjectKeys) {
          truncated = true;
          droppedItemsCount += keys.length - maxObjectKeys;
        }

        for (const k of limitedKeys) {
          out[k] = sanitizeNode((node as Record<string, unknown>)[k], depth + 1);
        }
        return out;
      }

      return node;
    };

    const sanitized = sanitizeNode(input, 1) as T;
    return {
      sanitized,
      truncated,
      droppedItemsCount,
      truncatedStringsCount
    };
  }

  /**
   * Suggests pagination or chunking slicing parameters when cardinality exceeds limits.
   */
  public suggestSlicing(cardinality: number, maxAllowed: number = DEFAULT_MAX_COLLECTION_SIZE): SlicingSuggestion {
    const batchSize = Math.max(1, Math.min(cardinality, maxAllowed));
    const totalChunks = Math.ceil(cardinality / batchSize);
    return {
      recommendedBatchSize: batchSize,
      totalChunks
    };
  }
}

export const defaultInputLimiter = new StrictInputLimiter();

export function createInputLimiter(): StrictInputLimiter {
  return new StrictInputLimiter();
}

