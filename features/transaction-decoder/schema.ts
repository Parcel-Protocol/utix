import { err, ok, type Result } from "@/core/result/result";
import type { TransactionDecoderErrorCode } from "@/features/transaction-decoder/types";

export interface TransactionDecoderInput {
  xdr: string;
}

export function parseTransactionDecoderInput(raw: string): Result<TransactionDecoderInput, TransactionDecoderErrorCode> {
  const trimmed = raw.trim();
  if (!trimmed) {
    return err("empty_input");
  }
  return ok({ xdr: trimmed });
}
