import { err, ok, type Result } from "@/core/result/result";
import { normalizeInput } from "@/core/lib/strings";
import type { SimulationExplainerErrorCode, SimulationExplainerInput } from "@/features/simulation-explainer/types";

/** Parses raw form input into a validated request, without throwing. */
export function parseSimulationExplainerInput(raw: string): Result<SimulationExplainerInput, SimulationExplainerErrorCode> {
  const value = normalizeInput(raw);
  if (!value) return err("empty_input");
  return ok({ value });
}
