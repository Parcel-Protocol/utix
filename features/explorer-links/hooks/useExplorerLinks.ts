"use client";

import { useState } from "react";
import { useNetwork } from "@/core/network/NetworkProvider";
import type {
  ExplorerLinksErrorCode,
  ExplorerLinksResult,
} from "@/features/explorer-links/types";
import {
  parseExplorerLinksInput,
  generateExplorerLinks,
} from "@/features/explorer-links/lib";

type State =
  | { status: "idle" }
  | { status: "error"; code: ExplorerLinksErrorCode }
  | { status: "success"; result: ExplorerLinksResult };

export function useExplorerLinks() {
  const { network } = useNetwork();
  const [state, setState] = useState<State>({ status: "idle" });

  function submit(input: string) {
    const parseResult = parseExplorerLinksInput(input);
    if (!parseResult.ok) {
      setState({ status: "error", code: parseResult.error });
      return;
    }

    const networkKey = network.name === "Public Global Stellar Network" ? "mainnet" : "testnet";
    const result = generateExplorerLinks({
      identifier: parseResult.value.identifier,
      network: networkKey as "mainnet" | "testnet",
    });

    if (!result.ok) {
      setState({ status: "error", code: result.error });
      return;
    }

    setState({ status: "success", result: result.value });
  }

  function reset() {
    setState({ status: "idle" });
  }

  return { state, submit, reset };
}
