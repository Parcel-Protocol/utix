import { useState } from "react";
import { useNetwork } from "@/core/network/useNetwork";
import { decodeEnvelope } from "@/features/transaction-decoder/lib/transactionDecoder";
import { parseTransactionDecoderInput } from "@/features/transaction-decoder/schema";
import type {
  DecodedTransactionResult,
  TransactionDecoderErrorCode
} from "@/features/transaction-decoder/types";

export type State =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "error"; code: TransactionDecoderErrorCode }
  | { status: "success"; result: DecodedTransactionResult };

export function useTransactionDecoder() {
  const { network } = useNetwork();
  const [state, setState] = useState<State>({ status: "idle" });

  async function submit(rawXdr: string) {
    setState({ status: "pending" });
    const parseResult = parseTransactionDecoderInput(rawXdr);
    if (!parseResult.ok) {
      setState({ status: "error", code: parseResult.error });
      return;
    }

    const decodeRes = decodeEnvelope(parseResult.value, network);
    if (!decodeRes.ok) {
      setState({ status: "error", code: decodeRes.error });
      return;
    }

    setState({ status: "success", result: decodeRes.value });
  }

  function reset() {
    setState({ status: "idle" });
  }

  return { state, submit, reset };
}
