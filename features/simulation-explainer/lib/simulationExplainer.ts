import { xdr } from "@stellar/stellar-sdk";
import { ok, err, type Result } from "@/core/result/result";
import { sorobanRpc, isRpcFailure } from "@/core/rpc/client";
import type { StellarNetwork } from "@/core/network/types";
import type {
  SimulationExplainerInput,
  SimulationExplainerResult,
  SimulationExplainerErrorCode,
  ResourceCost,
  FeeBreakdown,
  FootprintSummary,
  AuthRequirement,
  DiagnosticEventSummary
} from "@/features/simulation-explainer/types";
import { SimulationExplainerError } from "@/features/simulation-explainer/lib/simulationExplainer.errors";

const MAX_NETWORK_CPU = 100_000_000;
const MAX_NETWORK_MEM = 41_943_040; // 40 MB

export function explainContractError(rawError: string): string {
  if (rawError.includes("BudgetExceeded") || rawError.includes("CpuLimitExceeded")) {
    return "Budget Exceeded: Contract execution required more CPU instructions than the transaction budget allowed.";
  }
  if (rawError.includes("MemLimitExceeded")) {
    return "Memory Limit Exceeded: Contract memory allocation exceeded the transaction memory limit.";
  }
  if (rawError.includes("HostError") || rawError.includes("Error(Contract")) {
    return `Contract Trapped / Reverted: Execution failed in host environment (${rawError}).`;
  }
  if (rawError.includes("MissingAuth") || rawError.includes("NotAuthorized")) {
    return "Authorization Failure: Invocation requires cryptographic credentials or signatures that were not provided.";
  }
  return rawError;
}

export function parseSimulationResponse(raw: unknown): SimulationExplainerResult {
  if (!raw || typeof raw !== "object") {
    throw new SimulationExplainerError("parse_error", "Simulation response must be a JSON object.");
  }

  const envelope = raw as Record<string, unknown>;
  const res = (envelope.result && typeof envelope.result === "object" ? envelope.result : envelope) as Record<string, unknown>;

  const latestLedger = Number(res.latestLedger ?? 0);

  const costObj = (res.cost && typeof res.cost === "object" ? res.cost : {}) as Record<string, string>;
  const cpuInsns = String(costObj.cpuInsns ?? "0");
  const memBytes = String(costObj.memBytes ?? "0");

  const cpuNum = Number(cpuInsns) || 0;
  const memNum = Number(memBytes) || 0;

  const cost: ResourceCost = {
    cpuInsns: cpuNum.toLocaleString("en-US"),
    memBytes: `${memNum.toLocaleString("en-US")} B`,
    cpuPercentage: Math.min(100, Math.round((cpuNum / MAX_NETWORK_CPU) * 100)),
    memPercentage: Math.min(100, Math.round((memNum / MAX_NETWORK_MEM) * 100))
  };

  const minFeeStroops = String(res.minResourceFee ?? "0");
  const feeNum = Number(minFeeStroops) || 0;
  const fees: FeeBreakdown = {
    minResourceFeeStroops: `${feeNum.toLocaleString("en-US")} stroops`,
    minResourceFeeXlm: `${(feeNum / 10_000_000).toFixed(7)} XLM`
  };

  let readOnlyCount = 0;
  let readWriteCount = 0;

  if (typeof res.transactionData === "string" && res.transactionData.trim()) {
    try {
      const txData = xdr.SorobanTransactionData.fromXDR(res.transactionData, "base64");
      readOnlyCount = txData.resources().footprint().readOnly().length;
      readWriteCount = txData.resources().footprint().readWrite().length;
    } catch {
      // Fallback if transactionData cannot be decoded
    }
  }

  const restorePreamble = res.restorePreamble as Record<string, unknown> | undefined;
  const restoreRequired = Boolean(restorePreamble);
  const restoreFeeStroops = restorePreamble?.minResourceFee
    ? `${Number(restorePreamble.minResourceFee).toLocaleString("en-US")} stroops`
    : undefined;

  const footprint: FootprintSummary = {
    readOnlyCount,
    readWriteCount,
    restoreRequired,
    restoreFeeStroops
  };

  const auth: AuthRequirement[] = [];
  const resultsArr = Array.isArray(res.results) ? res.results : [];
  for (const item of resultsArr) {
    if (item && typeof item === "object" && Array.isArray((item as Record<string, unknown>).auth)) {
      const authList = (item as Record<string, unknown>).auth as string[];
      for (const entryStr of authList) {
        try {
          const entry = xdr.SorobanAuthorizationEntry.fromXDR(entryStr, "base64");
          const credType = entry.credentials().switch().name;
          auth.push({
            address: credType,
            invocationCount: 1
          });
        } catch {
          auth.push({ invocationCount: 1 });
        }
      }
    }
  }

  const events: DiagnosticEventSummary[] = [];
  const eventsArr = Array.isArray(res.events) ? res.events : [];
  for (const ev of eventsArr) {
    if (typeof ev === "string") {
      try {
        const diag = xdr.DiagnosticEvent.fromXDR(ev, "base64");
        events.push({
          type: diag.event().type().name,
          contractId: diag.event().contractId()?.toString("hex"),
          topics: diag.event().body().v0().topics().map((t) => t.switch().name)
        });
      } catch {
        events.push({ type: "diagnostic", topics: [] });
      }
    } else if (ev && typeof ev === "object") {
      const evObj = ev as Record<string, unknown>;
      events.push({
        type: String(evObj.type ?? "event"),
        topics: []
      });
    }
  }

  let status: SimulationExplainerResult["status"] = "success";
  let errorExplanation: string | undefined;

  if (res.error) {
    status = "failed";
    errorExplanation = explainContractError(String(res.error));
  } else if (restoreRequired) {
    status = "restore_required";
  }

  return {
    status,
    latestLedger,
    cost,
    fees,
    footprint,
    auth,
    events,
    errorExplanation,
    rawResponseJson: JSON.stringify(envelope, null, 2)
  };
}

export async function runSimulationExplainer(
  input: SimulationExplainerInput,
  network: StellarNetwork = "testnet",
  signal?: AbortSignal
): Promise<Result<SimulationExplainerResult, SimulationExplainerErrorCode>> {
  const trimmed = input.value.trim();
  if (!trimmed) {
    return err("empty_input");
  }

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsedJson = JSON.parse(trimmed);
      const result = parseSimulationResponse(parsedJson);
      return ok(result);
    } catch (e: unknown) {
      if (e instanceof SimulationExplainerError) return err(e.code);
      return err("parse_error");
    }
  }

  try {
    const rpcResponse = await sorobanRpc<Record<string, unknown>>(
      "simulateTransaction",
      { transaction: trimmed },
      { network, signal }
    );

    if (isRpcFailure(rpcResponse)) {
      return err("rpc_error");
    }

    const explained = parseSimulationResponse(rpcResponse);
    return ok(explained);
  } catch (e: unknown) {
    if (e instanceof SimulationExplainerError) return err(e.code);
    return err("simulation_failed");
  }
}
