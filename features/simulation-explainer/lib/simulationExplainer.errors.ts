import type { SimulationExplainerErrorCode } from "@/features/simulation-explainer/types";

export class SimulationExplainerError extends Error {
  readonly code: SimulationExplainerErrorCode;

  constructor(code: SimulationExplainerErrorCode, message: string) {
    super(message);
    this.name = "SimulationExplainerError";
    this.code = code;
  }
}

export function toSimulationExplainerErrorCode(error: unknown): SimulationExplainerErrorCode {
  if (error instanceof SimulationExplainerError) {
    return error.code;
  }
  return "invalid_input";
}
