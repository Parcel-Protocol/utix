export interface ResourceCost {
  cpuInsns: string;
  memBytes: string;
  cpuPercentage: number;
  memPercentage: number;
}

export interface FeeBreakdown {
  minResourceFeeStroops: string;
  minResourceFeeXlm: string;
}

export interface FootprintSummary {
  readOnlyCount: number;
  readWriteCount: number;
  restoreRequired: boolean;
  restoreFeeStroops?: string;
}

export interface AuthRequirement {
  address?: string;
  functionName?: string;
  invocationCount: number;
}

export interface DiagnosticEventSummary {
  type: string;
  contractId?: string;
  topics: string[];
  data?: string;
}

export interface SimulationExplainerResult {
  status: "success" | "failed" | "restore_required";
  latestLedger: number;
  cost: ResourceCost;
  fees: FeeBreakdown;
  footprint: FootprintSummary;
  auth: AuthRequirement[];
  events: DiagnosticEventSummary[];
  errorExplanation?: string;
  rawResponseJson: string;
}

export interface SimulationExplainerInput {
  value: string;
}

export type SimulationExplainerErrorCode =
  | "empty_input"
  | "invalid_input"
  | "simulation_failed"
  | "rpc_error"
  | "parse_error";
