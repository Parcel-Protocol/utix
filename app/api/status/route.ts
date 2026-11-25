import { correlationFromRequest } from "@/core/telemetry/request-correlation";
import { emitTelemetry, newCorrelationId } from "@/core/telemetry/telemetry";
import { buildStatusResponse } from "@/core/status/service-config";

// Contributor diagnostics: local setup and dependency failures surface as a
// structured status payload so the route itself never throws on bad config.
export const runtime = "nodejs";

// Read the environment and the clock per request, never at build time.
export const dynamic = "force-dynamic";

/** Public, read-only status: the service notice plus the schema-backed feed. */
export function GET(request?: Request): Response {
  const correlationId = request
    ? correlationFromRequest(request).correlationId
    : newCorrelationId();
  const startedAt = Date.now();
  try {
    const response = buildStatusResponse(process.env, Date.now());
    const headers = new Headers(response.headers);
    headers.set("x-correlation-id", correlationId);
    emitTelemetry({
      op: "api.status",
      actorType: "client",
      correlationId,
      result: response.status >= 400 ? "failure" : "success",
      errorCode: response.status >= 400 ? `http_${response.status}` : undefined,
      latencyMs: Date.now() - startedAt
    });
    return Response.json(response.body, { status: response.status, headers });
  } catch {
    emitTelemetry({ op: "api.status", actorType: "client", correlationId, result: "failure", errorCode: "internal_error", latencyMs: Date.now() - startedAt });
    return Response.json({ error: "internal_error" }, { status: 500, headers: { "x-correlation-id": correlationId } });
  }
}
