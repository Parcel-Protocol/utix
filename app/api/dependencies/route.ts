import { buildDependencyPublicStatus } from "@/core/status/dependency-health";
import { probePublicDependencies } from "@/core/status/dependency-probe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Public dependency status uses live bounded probes, never private diagnostics. */
export async function GET(): Promise<Response> {
  const signals = await probePublicDependencies({
    horizonUrl: process.env.NEXT_PUBLIC_HORIZON_TESTNET_URL,
    sorobanRpcUrl: process.env.NEXT_PUBLIC_SOROBAN_RPC_TESTNET_URL
  });
  const response = buildDependencyPublicStatus(process.env, Date.now(), signals);
  return Response.json(response.body, { status: response.status, headers: response.headers });
}
