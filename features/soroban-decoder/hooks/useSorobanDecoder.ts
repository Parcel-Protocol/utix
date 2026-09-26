"use client";

import { useState } from "react";
import { useNetwork } from "@/core/network/NetworkProvider";
import { decodeSorobanXdr } from "@/features/soroban-decoder/lib/sorobanDecoder";
import { parseSorobanDecoderInput } from "@/features/soroban-decoder/schema";
import type {
  SorobanDecoderResult,
  SorobanDecoderErrorCode
} from "@/features/soroban-decoder/types";

export type State =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "error"; code: SorobanDecoderErrorCode }
  | { status: "success"; result: SorobanDecoderResult };

export function useSorobanDecoder() {
  const { network } = useNetwork();
  const [state, setState] = useState<State>({ status: "idle" });

  async function submit(rawXdr: string) {
    setState({ status: "pending" });
    const parseResult = parseSorobanDecoderInput(rawXdr);
    if (!parseResult.ok) {
      setState({ status: "error", code: parseResult.code });
      return;
    }

    const decodeRes = decodeSorobanXdr(parseResult.value, network);
    if (!decodeRes.ok) {
      setState({ status: "error", code: decodeRes.code });
      return;
    }

    setState({ status: "success", result: decodeRes.value });
  }

  function reset() {
    setState({ status: "idle" });
  }

  return { state, submit, reset };
}
