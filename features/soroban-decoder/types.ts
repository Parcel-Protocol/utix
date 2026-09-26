import type { StellarNetwork as Network } from "@/core/network/types";

export type SorobanDecoderErrorCode = "empty_input" | "malformed_xdr" | "unsupported_envelope";

export interface ScValNode {
  type: string;
  value: string;
  children?: ScValNode[];
}

export interface SimulationSummary {
  minResourceFee: string;
  cpuInstructions: string;
  memoryBytes: string;
  authEntriesCount: number;
}

export interface SorobanDecoderResult {
  contractId: string | null;
  functionName: string | null;
  specAvailable: boolean;
  argsTree: ScValNode[];
  simulation: SimulationSummary | null;
  readOnly: boolean;
  network: Network;
}
