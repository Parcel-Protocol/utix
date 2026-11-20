import { ok, type Result } from "@/core/result/result";
import type { KeypairGeneratorErrorCode, KeypairGeneratorInput } from "@/features/keypair-generator/types";

/** Parses raw form input into a validated request, without throwing. */
export function parseKeypairGeneratorInput(_raw: string): Result<KeypairGeneratorInput, KeypairGeneratorErrorCode> {
  return ok({});
}
