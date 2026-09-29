"use client";

import { useState } from "react";
import { useNetwork } from "@/core/network/NetworkProvider";
import type {
  SorobanFeeEstimatorErrorCode,
  SorobanResourceFeeEstimate,
} from "@/features/soroban-fee-estimator/types";
import { parseInput, fetchFeeStats, estimateFees } from "@/features/soroban-fee-estimator/lib";

type State =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "error"; code: SorobanFeeEstimatorErrorCode }
  | { status: "success"; estimate: SorobanResourceFeeEstimate };

export function useSorobanFeeEstimator() {
  const { network } = useNetwork();
  const [state, setState] = useState<State>({ status: "idle" });

  async function submit(envelope: string) {
    setState({ status: "pending" });

    const parseResult = parseInput(envelope);
    if (!parseResult.ok) {
      setState({ status: "error", code: parseResult.error });
      return;
    }

    const networkKey = network.name === "Public Global Stellar Network" ? "mainnet" : "testnet";
    const pricingResult = await fetchFeeStats(networkKey as "mainnet" | "testnet");

    if (!pricingResult.ok) {
      setState({ status: "error", code: pricingResult.error });
      return;
    }

    const estimateResult = estimateFees(parseResult.value.envelope, pricingResult.value);
    if (!estimateResult.ok) {
      setState({ status: "error", code: estimateResult.error });
      return;
    }

    setState({ status: "success", estimate: estimateResult.value });
  }

  function reset() {
    setState({ status: "idle" });
  }

  return { state, submit, reset };
}
