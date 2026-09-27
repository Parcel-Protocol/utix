import { describe, it, expect } from "vitest";
import {
  parseSimulationResponse,
  explainContractError
} from "@/features/simulation-explainer/lib/simulationExplainer";

describe("simulationExplainer lib", () => {
  it("parses valid simulation success response", () => {
    const raw = {
      jsonrpc: "2.0",
      id: 1,
      result: {
        latestLedger: 500000,
        cost: { cpuInsns: "5000000", memBytes: "200000" },
        minResourceFee: "25000"
      }
    };

    const explained = parseSimulationResponse(raw);
    expect(explained.status).toBe("success");
    expect(explained.latestLedger).toBe(500000);
    expect(explained.cost.cpuPercentage).toBe(5);
    expect(explained.fees.minResourceFeeStroops).toContain("25,000");
  });

  it("parses simulation error response and diagnoses reason", () => {
    const raw = {
      jsonrpc: "2.0",
      id: 1,
      result: {
        latestLedger: 500000,
        error: "HostError: Error(Contract, #12)",
        cost: { cpuInsns: "1000", memBytes: "100" }
      }
    };

    const explained = parseSimulationResponse(raw);
    expect(explained.status).toBe("failed");
    expect(explained.errorExplanation).toContain("Contract Trapped / Reverted");
  });

  it("detects when state restoration is required via restorePreamble", () => {
    const raw = {
      jsonrpc: "2.0",
      id: 1,
      result: {
        latestLedger: 500000,
        restorePreamble: {
          minResourceFee: "50000",
          transactionData: ""
        }
      }
    };

    const explained = parseSimulationResponse(raw);
    expect(explained.status).toBe("restore_required");
    expect(explained.footprint.restoreRequired).toBe(true);
    expect(explained.footprint.restoreFeeStroops).toContain("50,000");
  });

  it("explains out-of-budget error appropriately", () => {
    const message = explainContractError("BudgetExceeded: reached maximum allowed cpu instructions");
    expect(message).toContain("Budget Exceeded");
  });

  it("explains authorization error appropriately", () => {
    const message = explainContractError("MissingAuth: requires signature from account");
    expect(message).toContain("Authorization Failure");
  });
});
