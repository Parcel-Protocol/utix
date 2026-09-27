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

export const MAX_REDACT_DEPTH = 16;
export const MAX_SCANNABLE_STRING_LENGTH = 500_000;

/** Embedded Stellar secret seed (56 characters starting with S or M). */
const EMBEDDED_STELLAR_SECRET = /[SM][A-Z2-7]{55}/g;

/** Embedded bearer tokens / authorization headers. */
const EMBEDDED_BEARER_TOKEN = /Bearer\s+[A-Za-z0-9._~+/-]+/gi;

export const STELLAR_PUBLIC_ADDRESS_REGEX = /[GC][A-Z2-7]{55}/g;

export interface RedactOptions {
  /** If true, redacts all Stellar public addresses (G... / C...) in values. */
  redactAddresses?: boolean;
}

function isSensitiveKey(key: string): boolean {
  if (/public/i.test(key)) return false;
  return /secret|seed|password|passphrase|token|auth|authorization|credential|bearer|cookie|raw_?body|response_?body|request_?body|http_?body|response_?data|^(?:body|raw)$|disallowed_?address|forbidden_?address|disallowed_?account|forbidden_?account|(?:^|[_\b]|private|api|secret|signing)key/i.test(key);
}

function looksLikeSecret(value: string): boolean {
  if (value.length < 10 || value.length > 128) return false;
  return STELLAR_SECRET_PREFIXES.some((prefix) => value.startsWith(prefix));
}

/**
 * Scans and scrubs secret seeds, bearer tokens, or full secrets in strings.
 */
function scrubString(value: string): string {
  if (looksLikeSecret(value)) return "[REDACTED]";
  const candidate =
    value.length > MAX_SCANNABLE_STRING_LENGTH
      ? value.slice(0, MAX_SCANNABLE_STRING_LENGTH) + "…[TRUNCATED]"
      : value;
  return candidate
    .replace(/[SM][A-Z2-7]{55}/g, "[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, "[REDACTED]");
}

/**
 * Recursively replaces values that look like secret material so no sink ever
 * sees a seed key, passphrase or bearer token. Keys are always preserved so
 * the shape of a record stays stable and queryable.
 *
 * Implements bounded traversal depth (MAX_REDACT_DEPTH) and cycle detection
 * to guarantee that circular objects never cause infinite recursion and the
 * result is safely serializable.
 */
export function redact(
  value: unknown,
  depth = 0,
  seen: WeakSet<object> = new WeakSet<object>(),
  options?: RedactOptions
): unknown {
  if (typeof value === "string") {
    let scrubbed = scrubString(value);
    if (options?.redactAddresses) {
      scrubbed = scrubbed.replace(STELLAR_PUBLIC_ADDRESS_REGEX, "[REDACTED]");
    }
    return scrubbed;
  }
  if (value === null || value === undefined) return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return value;
  }
  if (typeof value === "function" || typeof value === "symbol") {
    return undefined;
  }

  if (depth >= MAX_REDACT_DEPTH) {
    return "[TRUNCATED_DEPTH]";
  }

  if (typeof value === "object") {
    if (seen.has(value)) {
      return "[CIRCULAR]";
    }
    seen.add(value);

    if (Array.isArray(value)) {
      return value.map((entry) => redact(entry, depth + 1, seen, options));
    }

    if (value instanceof Error) {
      const out: Record<string, unknown> = {
        name: value.name,
        message: scrubString(value.message)
      };
      if (value.stack) {
        out.stack = scrubString(value.stack);
      }
      return out;
    }

    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = isSensitiveKey(key)
        ? "[REDACTED]"
        : redact(entry, depth + 1, seen, options);
    }
    return out;
  }

  return value;
}

export interface TelemetryCaptureSink extends TelemetrySink {
  readonly events: readonly TelemetryEvent[];
  clear(): void;
  find(predicate: (event: TelemetryEvent) => boolean): TelemetryEvent | undefined;
  filter(predicate: (event: TelemetryEvent) => boolean): TelemetryEvent[];
  latest(): TelemetryEvent | undefined;
}

/** In-memory capture sink for testing assertions against emitted telemetry events. */
export function createCaptureSink(): TelemetryCaptureSink {
  const captured: TelemetryEvent[] = [];
  return {
    get events() {
      return [...captured];
    },
    emit(event: TelemetryEvent): void {
      captured.push(event);
    },
    clear(): void {
      captured.length = 0;
    },
    find(predicate: (event: TelemetryEvent) => boolean): TelemetryEvent | undefined {
      return captured.find(predicate);
    },
    filter(predicate: (event: TelemetryEvent) => boolean): TelemetryEvent[] {
      return captured.filter(predicate);
    },
    latest(): TelemetryEvent | undefined {
      return captured[captured.length - 1];
    }
  };
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
    errorCode: fields.errorCode ? scrubString(fields.errorCode) : undefined,
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