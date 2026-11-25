/**
 * Public dependency health status from explicit operator-verified signals.
 * Never assume an unprobed upstream is healthy. Diagnostics, URLs and tokens
 * are not part of the public result.
 */
import type { ComponentStatus, TrustedStatusState } from "@/core/status/types";
import { buildStatusResponse, type ServiceEnv } from "@/core/status/service-config";

export const PUBLIC_DEPENDENCIES = ["horizon", "soroban_rpc"] as const;
export type PublicDependency = (typeof PUBLIC_DEPENDENCIES)[number];
export type DependencySignal = "healthy" | "degraded" | "down";
export type DependencyHealthInput = Partial<Record<PublicDependency, DependencySignal>>;

export interface DependencyPublicResponse {
  readonly status: 200 | 503;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: ReturnType<typeof buildStatusResponse>["body"];
}

export function buildDependencyPublicStatus(
  env: ServiceEnv,
  now: number,
  signals: DependencyHealthInput
): DependencyPublicResponse {
  const components = PUBLIC_DEPENDENCIES.map((id) => {
    const signal = Object.hasOwn(signals, id) ? signals[id] : undefined;
    const status: ComponentStatus =
      signal === "healthy" ? "operational" :
      signal === "down" ? "major_outage" : "degraded";
    return {
      id,
      name: id === "horizon" ? "Horizon API" : "Soroban RPC",
      status,
      visibility: "public" as const
    };
  });
  const trusted: TrustedStatusState = { components, incidents: [], maintenance: [] };
  const response = buildStatusResponse(env, now, trusted);
  return { status: response.status, headers: response.headers, body: response.body };
}

/**
 * A status provided through a private, already-authenticated monitor can be
 * reported explicitly. Environment configuration alone is NOT a live probe.
 * Missing/invalid signals appear degraded; no URL or error text leaks.
 */
export function parseDependencySignals(
  input: Readonly<Record<string, unknown>>
): DependencyHealthInput {
  const output: DependencyHealthInput = {};
  for (const id of PUBLIC_DEPENDENCIES) {
    const value = input[id];
    if (value === "healthy" || value === "degraded" || value === "down") {
      output[id] = value;
    }
  }
  return output;
}
