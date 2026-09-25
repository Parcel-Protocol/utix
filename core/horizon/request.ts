import { emitTelemetry, errorCodeOf, newCorrelationId } from "@/core/telemetry/telemetry";

export const HORIZON_REQUEST_TIMEOUT_MS = 10_000;

export class HorizonRequestCancelledError extends Error {
  constructor() {
    super("Horizon request cancelled");
    this.name = "HorizonRequestCancelledError";
  }
}

export class HorizonRequestTimeoutError extends Error {
  constructor() {
    super("Horizon request timed out");
    this.name = "HorizonRequestTimeoutError";
  }
}

export function isCancelledError(error: unknown): boolean {
  return (
    error instanceof HorizonRequestCancelledError ||
    (error instanceof DOMException && error.name === "AbortError")
  );
}

export function isTimeoutError(error: unknown): boolean {
  return error instanceof HorizonRequestTimeoutError;
}

export interface HorizonRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Correlation id to thread through telemetry for this request. */
  correlationId?: string;
}

/**
 * Bounds a Horizon SDK call with a timeout and a caller cancellation signal.
 *
 * The SDK's builders return plain promises with no way to abort them, so this
 * wraps the promise rather than the transport: the underlying request may still
 * finish, but its result is discarded and the caller gets a stable, typed
 * rejection instead of hanging forever.
 *
 * Cancellation and timeout are distinct errors on purpose — a timeout is worth
 * retrying and a cancellation is not.
 */
export function runHorizonRequest<T>(
  request: PromiseLike<T>,
  options: HorizonRequestOptions = {}
): Promise<T> {
  const { signal, timeoutMs = HORIZON_REQUEST_TIMEOUT_MS } = options;

  if (signal?.aborted) return Promise.reject(new HorizonRequestCancelledError());

  const start = performance.now();
  const correlationId = options.correlationId ?? newCorrelationId();

  const emit = (result: "success" | "failure", errorCode?: string): void => {
    emitTelemetry({
      op: "horizon.request",
      actorType: "client",
      result,
      latencyMs: performance.now() - start,
      correlationId,
      errorCode
    });
  };

  return new Promise<T>((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      clearTimeout(timeoutId);
      signal?.removeEventListener("abort", handleAbort);
    };

    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };

    const handleAbort = () => {
      emit("failure", "cancelled");
      settle(() => reject(new HorizonRequestCancelledError()));
    };

    signal?.addEventListener("abort", handleAbort, { once: true });

    const timeoutId = setTimeout(() => {
      emit("failure", "timeout");
      settle(() => reject(new HorizonRequestTimeoutError()));
    }, timeoutMs);

    Promise.resolve(request).then(
      (value) => {
        emit("success");
        settle(() => resolve(value));
      },
      (error) => {
        emit("failure", errorCodeOf(error));
        settle(() => reject(error));
      }
    );
  });
}
