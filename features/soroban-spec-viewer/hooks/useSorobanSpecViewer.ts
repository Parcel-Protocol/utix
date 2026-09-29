"use client";

import { useState } from "react";
import { useNetwork } from "@/core/network/NetworkProvider";
import type {
  SorobanSpecViewerErrorCode,
  SorobanContractSpec,
} from "@/features/soroban-spec-viewer/types";
import { fetchSorobanContractSpec } from "@/features/soroban-spec-viewer/lib";

type State =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "error"; code: SorobanSpecViewerErrorCode }
  | { status: "success"; spec: SorobanContractSpec };

export function useSorobanSpecViewer() {
  const { network } = useNetwork();
  const [state, setState] = useState<State>({ status: "idle" });

  async function submit(contractAddress: string) {
    setState({ status: "pending" });

    const networkKey = network.name === "Public Global Stellar Network" ? "mainnet" : "testnet";
    const result = await fetchSorobanContractSpec({
      contractAddress,
      network: networkKey as "mainnet" | "testnet",
    });

    if (!result.ok) {
      setState({ status: "error", code: result.error });
      return;
    }

    setState({ status: "success", spec: result.value });
  }

  function reset() {
    setState({ status: "idle" });
  }

  return { state, submit, reset };
}
