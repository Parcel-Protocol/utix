/**
 * HTTP-to-worker correlation boundary. Only a bounded opaque identifier is
 * accepted from callers; payloads and credentials never enter traces.
 */
import { emitTelemetry, newCorrelationId } from "@/core/telemetry/telemetry";
import type { JobInput } from "@/core/workers/queue";

export const CORRELATION_HEADER = "x-correlation-id";
const VALID_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export interface RequestCorrelation {
  readonly correlationId: string;
  /** Preserve the same identifier across async jobs, including retries. */
  job(input: Omit<JobInput, "correlationId">): JobInput;
}

export function correlationFromRequest(request: Request): RequestCorrelation {
  const received = request.headers.get(CORRELATION_HEADER);
  const correlationId = received !== null && VALID_ID.test(received)
    ? received
    : newCorrelationId();
  return {
    correlationId,
    job: (input) => ({ ...input, correlationId })
  };
}

/**
 * The response header is always present, including exceptions; no exception
 * body or bearer token is returned to the HTTP caller.
 */
export async function withRequestCorrelation(
  request: Request,
  operation: string,
  handler: (context: RequestCorrelation) => Response | Promise<Response>
): Promise<Response> {
  const context = correlationFromRequest(request);
  const start = Date.now();
  let response: Response;
  try {
    response = await handler(context);
  } catch {
    response = Response.json({ error: "internal_error" }, { status: 500 });
  }
  const headers = new Headers(response.headers);
  headers.set(CORRELATION_HEADER, context.correlationId);
  emitTelemetry({
    op: operation,
    actorType: "client",
    correlationId: context.correlationId,
    result: response.status >= 400 ? "failure" : "success",
    errorCode: response.status >= 400 ? `http_${response.status}` : undefined,
    latencyMs: Date.now() - start
  });
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
