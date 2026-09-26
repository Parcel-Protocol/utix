/**
 * Structured telemetry for every critical execution path.
 *
 * Emits a single JSON object per operation with the fields maintainers query
 * on: `op`, `actorType`, `result`, `latencyMs`, `correlationId` and `errorCode`.
 * Sensitive values are redacted before a record is ever emitted — a string that
 * looks like a Stellar secret seed key is replaced before it reaches a sink.
 *
 * The default sink writes one JSON line to the console. Tests swap in an
 * in-memory sink with `setTelemetrySink` so assertions can inspect records.
 */

/** The fields every emitted record is guaranteed to carry. */
export const TELEMETRY_FIELDS = [
  "op",
  "actorType",
  "result",
  "latencyMs",
  "correlationId"
] as const;

export type TelemetryResult = "success" | "failure";
export type ActorType = "user" | "worker" | "client" | "system";

export interface TelemetryEvent {
  /** Dot-separated operation name, e.g. `horizon.request`. */
  op: string;
  /** Which kind of principal initiated the operation. */
  actorType: ActorType;
  result: TelemetryResult;
  /** Milliseconds between start and settle. */
  latencyMs: number;
  correlationId: string;
  timestamp: string;
  /** Stable failure code when `result` is `failure`. */
  errorCode?: string;
  /** Non-sensitive structured context. Redacted before emission. */
  payload?: Record<string, unknown>;
}

export interface TelemetrySink {
  emit(event: TelemetryEvent): void;
}

const STELLAR_SECRET_PREFIXES = ["S", "M"] as const;

function looksLikeSecret(value: string): boolean {
  if (value.length < 10 || value.length > 128) return false;
  return STELLAR_SECRET_PREFIXES.some((prefix) => value.startsWith(prefix));
}

/**
 * Recursively replaces values that look like secret material so no sink ever
 * sees a seed key, passphrase or bearer token. Keys are always preserved so
 * the shape of a record stays stable and queryable.
 */
export function redact(value: unknown): unknown {
  if (typeof value === "string") {
    return looksLikeSecret(value) ? "[REDACTED]" : value;
  }
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = /secret|seed|key|token|password|passphrase/i.test(key)
        ? "[REDACTED]"
        : redact(entry);
    }
    return out;
  }
  return value;
}

/** A cheap unique correlation id shared across the requests a single action fans out into. */
export function newCorrelationId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  const fallback = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto?.randomUUID;
  if (fallback) return fallback();
  return `corr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const consoleSink: TelemetrySink = {
  emit(event: TelemetryEvent): void {
    // Structured means machine-parseable: exactly one JSON object per line.
    console.info(JSON.stringify(redact(event)));
  }
};

let activeSink: TelemetrySink = consoleSink;

/** Swaps the sink. Used by tests and by headless worker runs. */
export function setTelemetrySink(next: TelemetrySink): TelemetrySink {
  const previous = activeSink;
  activeSink = next;
  return previous;
}

/** Restores the default console sink. */
export function resetTelemetrySink(): void {
  activeSink = consoleSink;
}

function errorCodeOf(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return error instanceof Error ? error.name : undefined;
}

export { errorCodeOf };

/** A value is a failure when it is a `Result` in the error position. */
function isResultFailure(value: unknown): value is { ok: false; code: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "ok" in value &&
    (value as { ok: unknown }).ok === false &&
    typeof (value as { code?: unknown }).code === "string"
  );
}

export interface EmitTelemetryFields {
  op: string;
  actorType: ActorType;
  result?: TelemetryResult;
  latencyMs?: number;
  correlationId?: string;
  errorCode?: string;
  payload?: Record<string, unknown>;
}

export function emitTelemetry(fields: EmitTelemetryFields): void {
  const record: TelemetryEvent = {
    op: fields.op,
    actorType: fields.actorType,
    result: fields.result ?? "success",
    latencyMs: fields.latencyMs ?? 0,
    correlationId: fields.correlationId ?? newCorrelationId(),
    errorCode: fields.errorCode,
    // Redaction happens here, at the boundary, so every sink — including an
    // in-memory test sink — only ever sees safe values.
    payload: typeof fields.payload === "object" && fields.payload !== null
      ? (redact(fields.payload) as Record<string, unknown>)
      : fields.payload,
    timestamp: new Date().toISOString()
  };
  activeSink.emit(record);
}

export interface MeasureOptions {
  actorType: ActorType;
  correlationId?: string;
  payload?: Record<string, unknown>;
}

/**
 * Runs `run` and emits one success or failure record with measured latency.
 *
 * Both error conventions are supported: a thrown exception and a returned
 * `Result` whose `ok` is `false`. Expected failures never throw in this
 * codebase, so most callers pass a function that returns a `Result`.
 */
export async function measure<T>(
  op: string,
  options: MeasureOptions,
  run: () => T | Promise<T>
): Promise<T> {
  const start = performance.now();
  const correlationId = options.correlationId ?? newCorrelationId();

  try {
    const value = await run();

    if (isResultFailure(value)) {
      emitTelemetry({
        op,
        actorType: options.actorType,
        result: "failure",
        latencyMs: performance.now() - start,
        correlationId,
        errorCode: value.code,
        payload: options.payload
      });
    } else {
      emitTelemetry({
        op,
        actorType: options.actorType,
        result: "success",
        latencyMs: performance.now() - start,
        correlationId,
        payload: options.payload
      });
    }

    return value;
  } catch (error) {
    emitTelemetry({
      op,
      actorType: options.actorType,
      result: "failure",
      latencyMs: performance.now() - start,
      correlationId,
      errorCode: errorCodeOf(error),
      payload: options.payload
    });
    throw error;
  }
}

/** Like `measure`, but for synchronous work that must not go through a microtask. */
export function measureSync<T>(
  op: string,
  options: MeasureOptions,
  run: () => T
): T {
  const start = performance.now();
  const correlationId = options.correlationId ?? newCorrelationId();
  const finish = (result: TelemetryResult, errorCode?: string): void => {
    emitTelemetry({
      op,
      actorType: options.actorType,
      result,
      latencyMs: performance.now() - start,
      correlationId,
      errorCode,
      payload: options.payload
    });
  };

try {
      const value = run();
      if (isResultFailure(value)) {
        finish("failure", value.code);
      } else {
        finish("success");
      }
      return value;
    } catch (error) {
      finish("failure", errorCodeOf(error));
      throw error;
    }
  }