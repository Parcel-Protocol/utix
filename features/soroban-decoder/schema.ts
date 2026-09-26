import { err, ok, type Result } from "@/core/result/result";
import type { SorobanDecoderErrorCode } from "@/features/soroban-decoder/types";

export interface SorobanDecoderInput {
  xdr: string;
  contractId?: string;
}

export function parseSorobanDecoderInput(raw: string): Result<SorobanDecoderInput, SorobanDecoderErrorCode> {
  const trimmed = raw.trim();
  if (!trimmed) {
    return err("empty_input");
  }
  return ok({ xdr: trimmed });
}
