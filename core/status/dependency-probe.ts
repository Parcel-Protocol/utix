/**
 * Bounded network checks for public dependency health. Only operator-selected
 * Stellar public endpoints from a fixed host allowlist are probed.
 * No secrets, response bodies or raw upstream errors appear in the feed.
 */
import { parseDependencySignals, type DependencyHealthInput } from "@/core/status/dependency-health";

const TRUSTED = new Set([
  "horizon-testnet.stellar.org",
  "horizon.stellar.org",
  "soroban-testnet.stellar.org",
  "soroban.stellar.org",
  "rpc-futurenet.stellar.org"
]);

export interface DependencyProbeOptions {
  horizonUrl?: string;
  sorobanRpcUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function safeEndpoint(input: string | undefined): string | null {
  if (!input) return null;
  try {
    const url = new URL(input);
    if (url.protocol !== "https:" || url.username || url.password ||
        url.search || url.hash || url.port || !TRUSTED.has(url.hostname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export async function probePublicDependencies(
  options: DependencyProbeOptions
): Promise<DependencyHealthInput> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = Math.max(1, Math.min(10_000, options.timeoutMs ?? 2_500));
  async function check(endpoint: string | undefined, rpc: boolean) {
    const url = safeEndpoint(endpoint);
    if (!url) return "degraded" as const;
    try {
      const response = await fetchImpl(url, {
        method: rpc ? "POST" : "GET",
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
        ...(rpc ? { headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }) } : {})
      });
      if (response.status === 429) return "degraded" as const;
      if (!response.ok) return "down" as const;
      if (rpc) {
        const result = await response.json() as { error?: unknown; result?: unknown };
        return result && !result.error && result.result ? "healthy" as const : "down" as const;
      }
      return "healthy" as const;
    } catch {
      return "down" as const;
    }
  }
  const [horizon, soroban_rpc] = await Promise.all([
    check(options.horizonUrl, false),
    check(options.sorobanRpcUrl, true)
  ]);
  return parseDependencySignals({ horizon, soroban_rpc });
}
