"use client";

import { useCallback, useRef, useState } from "react";
import { useNetwork } from "@/core/network/NetworkProvider";
import { isErr, type Result } from "@/core/result/result";
import { parseSimulationExplainerInput } from "@/features/simulation-explainer/schema";
import { runSimulationExplainer } from "@/features/simulation-explainer/lib/simulationExplainer";
import { toSimulationExplainerErrorCode } from "@/features/simulation-explainer/lib/simulationExplainer.errors";
import type { SimulationExplainerErrorCode, SimulationExplainerResult } from "@/features/simulation-explainer/types";

export type SimulationExplainerState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; result: SimulationExplainerResult }
  | { status: "error"; code: SimulationExplainerErrorCode };

export function useSimulationExplainer() {
  const { network } = useNetwork();
  const [state, setState] = useState<SimulationExplainerState>({ status: "idle" });
  const controller = useRef<AbortController | null>(null);

  const submit = useCallback(
    async (raw: string) => {
      controller.current?.abort();
      const parsed = parseSimulationExplainerInput(raw);
      if (isErr(parsed)) {
        setState({ status: "error", code: parsed.code });
        return;
      }

      const next = new AbortController();
      controller.current = next;
      setState({ status: "loading" });

      try {
        const result: Result<SimulationExplainerResult, SimulationExplainerErrorCode> = await runSimulationExplainer(
          parsed.value,
          network,
          next.signal
        );
        if (next.signal.aborted) return;
        setState(
          result.ok
            ? { status: "success", result: result.value }
            : { status: "error", code: result.code }
        );
      } catch (error) {
        if (next.signal.aborted) return;
        setState({ status: "error", code: toSimulationExplainerErrorCode(error) });
      }
    },
    [network]
  );

  const reset = useCallback(() => {
    controller.current?.abort();
    setState({ status: "idle" });
  }, []);

  return { state, submit, reset };
}
