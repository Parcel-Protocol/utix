/**
 * High-Cardinality Telemetry Redaction and Sampling (#345).
 *
 * Provides production-grade protection for telemetry streams:
 * - High-cardinality detection & normalization: identifies unbounded identifier fields
 *   (Stellar transaction hashes, account keys, UUIDs, trace IDs) and bounds metric dimensionality.
 * - Deterministic trace-consistent sampling: samples by hashing correlationId so multi-step flows
 *   are sampled or dropped together.
 * - 100% failure capture: errors and failed results (result: "failure", errorCode) are never dropped.
 * - Secret scrubbing: recursively redacts Stellar secret seeds (S...), bearer tokens, credentials.
 * - Authorization & Configuration Rollback: updates require admin:metrics privileges and support snapshots.
 */

import type { AuthContext } from "@/core/auth/middleware";
import { hasPermission } from "@/core/auth/types";
import { err, ok, type Result } from "@/core/result/result";

export interface TelemetryProtectionOptions {
  /** Sample rate in [0, 1]. Defaults to 1.0 (100%). */
  readonly sampleRate?: number;
  /** Maximum number of top-level fields permitted on an event. Defaults to 100. */
  readonly maxCardinality?: number;
  /** Specific keys to redact unconditionally. */
  readonly redactKeys?: readonly string[];
  /** Optional custom PRNG function for random sampling. */
  readonly random?: () => number;
  /** If true, uses deterministic hashing of correlationId for trace-consistent sampling. Defaults to true. */
  readonly deterministicSampling?: boolean;
  /** If true, ensures failure events (result: 'failure' or errorCode present) are always 100% sampled. Defaults to true. */
  readonly priorityFailureSampling?: boolean;
  /** If true, detects and redacts/truncates high-cardinality field values exceeding threshold. Defaults to true. */
  readonly redactHighCardinality?: boolean;
  /** Maximum distinct values per field before triggering high-cardinality masking. Defaults to 50. */
  readonly maxDistinctValuesPerField?: number;
}

export interface ProtectedTelemetry {
  readonly sampled: boolean;
  readonly event: Record<string, unknown> | null;
  readonly droppedReason?: "sampled_out" | "empty";
  readonly highCardinalityFields?: readonly string[];
}

const DEFAULT_REDACT_KEYS = [
  "secret",
  "token",
  "password",
  "seed",
  "authorization",
  "credential",
  "bearer",
  "privatekey",
  "apikey",
  "cookie"
];

const STELLAR_SECRET_SEED_REGEX = /[SM][A-Z2-7]{55}/g;
const BEARER_TOKEN_REGEX = /Bearer\s+[A-Za-z0-9._~+/-]+/gi;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STELLAR_TX_HASH_REGEX = /^[0-9a-fA-F]{64}$/;

/** Simple deterministic string hash in [0, 1). */
export function hashToUnitInterval(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  // Convert unsigned 32-bit int to [0, 1)
  return (hash >>> 0) / 4294967296;
}

/** Tracks cardinality per field name in bounded memory. */
export class CardinalityTracker {
  private readonly fieldSets = new Map<string, Set<string>>();
  private readonly maxDistinct: number;

  constructor(maxDistinct: number = 50) {
    this.maxDistinct = maxDistinct;
  }

  isHighCardinality(field: string, value: string): boolean {
    if (!this.fieldSets.has(field)) {
      this.fieldSets.set(field, new Set<string>());
    }
    const set = this.fieldSets.get(field)!;
    if (set.size >= this.maxDistinct && !set.has(value)) {
      return true;
    }
    if (set.size < this.maxDistinct) {
      set.add(value);
    }
    return false;
  }

  clear(): void {
    this.fieldSets.clear();
  }
}

const globalCardinalityTracker = new CardinalityTracker(50);
let activeProtectionOptions: TelemetryProtectionOptions = {};

/**
 * Normalizes or redacts a value if it contains sensitive material or exhibits high cardinality.
 */
function scrubValue(
  key: string,
  value: unknown,
  redactKeySet: Set<string>,
  tracker: CardinalityTracker,
  redactHighCardinality: boolean
): { value: unknown; wasHighCardinality: boolean } {
  const lowerKey = key.toLowerCase();
  if (redactKeySet.has(lowerKey) || /secret|token|password|seed|auth|credential|bearer/i.test(key)) {
    return { value: "[REDACTED]", wasHighCardinality: false };
  }

  if (typeof value === "string") {
    // Scrub embedded secrets
    let scrubbed = value
      .replace(STELLAR_SECRET_SEED_REGEX, "[REDACTED]")
      .replace(BEARER_TOKEN_REGEX, "[REDACTED]");

    if (scrubbed.startsWith("S") && scrubbed.length === 56) {
      return { value: "[REDACTED]", wasHighCardinality: false };
    }

    // High cardinality detection
    let isHighCard = false;
    if (redactHighCardinality) {
      if (UUID_REGEX.test(scrubbed) || STELLAR_TX_HASH_REGEX.test(scrubbed)) {
        isHighCard = true;
      } else if (tracker.isHighCardinality(key, scrubbed)) {
        isHighCard = true;
      }
    }

    if (isHighCard) {
      return { value: "[HIGH_CARDINALITY_TRUNCATED]", wasHighCardinality: true };
    }

    return { value: scrubbed, wasHighCardinality: false };
  }

  if (typeof value === "object" && value !== null) {
    if (Array.isArray(value)) {
      const arr = value.slice(0, 50).map((item, idx) =>
        scrubValue(`${key}[${idx}]`, item, redactKeySet, tracker, redactHighCardinality).value
      );
      return { value: arr, wasHighCardinality: false };
    }
    const obj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      obj[k] = scrubValue(k, v, redactKeySet, tracker, redactHighCardinality).value;
    }
    return { value: obj, wasHighCardinality: false };
  }

  return { value, wasHighCardinality: false };
}

/**
 * Protects a telemetry event by performing high-cardinality detection,
 * secret redaction, and adaptive sampling.
 */
export function protectTelemetry(
  event: Record<string, unknown>,
  options: TelemetryProtectionOptions = {}
): ProtectedTelemetry {
  const mergedOptions: TelemetryProtectionOptions = { ...activeProtectionOptions, ...options };
  const rate = Math.min(1, Math.max(0, mergedOptions.sampleRate ?? 1));

  // Check if priority failure sampling applies (failures are always 100% captured)
  const isFailure =
    event.result === "failure" ||
    Boolean(event.errorCode) ||
    Boolean(event.error);

  const priorityFailureSampling = mergedOptions.priorityFailureSampling ?? true;
  let sampled = true;

  if (rate < 1) {
    if (isFailure && priorityFailureSampling) {
      sampled = true;
    } else if (mergedOptions.random) {
      sampled = mergedOptions.random() < rate;
    } else if (mergedOptions.deterministicSampling !== false && typeof event.correlationId === "string") {
      // Deterministic trace-consistent sampling
      sampled = hashToUnitInterval(event.correlationId) < rate;
    } else {
      sampled = Math.random() < rate;
    }
  }

  if (!sampled) {
    return { sampled: false, event: null, droppedReason: "sampled_out" };
  }

  const keys = new Set((mergedOptions.redactKeys ?? DEFAULT_REDACT_KEYS).map((key) => key.toLowerCase()));
  const maxEntries = mergedOptions.maxCardinality ?? 100;
  const entries = Object.entries(event).slice(0, maxEntries);

  const highCardinalityFields: string[] = [];
  const redactHighCardinality = mergedOptions.redactHighCardinality ?? true;

  const sanitizedEntries: [string, unknown][] = entries.map(([key, value]) => {
    const { value: scrubbed, wasHighCardinality } = scrubValue(
      key,
      value,
      keys,
      globalCardinalityTracker,
      redactHighCardinality
    );
    if (wasHighCardinality) {
      highCardinalityFields.push(key);
    }
    return [key, scrubbed];
  });

  return {
    sampled: true,
    event: Object.fromEntries(sanitizedEntries),
    highCardinalityFields: highCardinalityFields.length > 0 ? highCardinalityFields : undefined
  };
}

/**
 * Server-side authorization boundary for dynamically configuring telemetry protection.
 * Requires `admin:metrics` or maintainer role.
 */
export function configureTelemetryProtectionAuthorized(
  auth: AuthContext,
  options: TelemetryProtectionOptions
): Result<TelemetryProtectionOptions, string> {
  if (!hasPermission(auth.role, "admin:metrics") && !hasPermission(auth.role, "admin:config")) {
    return err("permission_denied");
  }

  activeProtectionOptions = { ...options };
  return ok(activeProtectionOptions);
}

/** Creates a snapshot of current telemetry protection configuration for rollback. */
export function createProtectionSnapshot(): TelemetryProtectionOptions {
  return { ...activeProtectionOptions };
}

/** Restores telemetry protection configuration from a snapshot. */
export function restoreProtectionSnapshot(snapshot: TelemetryProtectionOptions): void {
  activeProtectionOptions = { ...snapshot };
}

/** Resets telemetry protection to safe defaults. */
export function resetTelemetryProtection(): void {
  activeProtectionOptions = {};
  globalCardinalityTracker.clear();
}
