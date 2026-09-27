import type { SimulationExplainerResult } from "@/features/simulation-explainer/types";

export const simulationExplainerFixture: SimulationExplainerResult = {
  status: "success",
  latestLedger: 123456,
  cost: {
    cpuInsns: "1,250,000",
    memBytes: "350,000 B",
    cpuPercentage: 1,
    memPercentage: 1
  },
  fees: {
    minResourceFeeStroops: "15,000 stroops",
    minResourceFeeXlm: "0.0015000 XLM"
  },
  footprint: {
    readOnlyCount: 2,
    readWriteCount: 1,
    restoreRequired: false
  },
  auth: [
    {
      address: "SorobanAddressCredentials",
      invocationCount: 1
    }
  ],
  events: [
    {
      type: "contract",
      topics: ["transfer"]
    }
  ],
  rawResponseJson: JSON.stringify(
    {
      jsonrpc: "2.0",
      id: 1,
      result: {
        latestLedger: 123456,
        cost: { cpuInsns: "1250000", memBytes: "350000" },
        minResourceFee: "15000"
      }
    },
    null,
    2
  )
};
