import { classifyHorizonError } from "@/core/horizon/errors";
import type { KeypairGeneratorErrorCode } from "@/features/keypair-generator/types";

/** Maps transport failures onto this tool's own error codes. */
export function toKeypairGeneratorErrorCode(error: unknown): KeypairGeneratorErrorCode {
  const { code } = classifyHorizonError(error);
  return code === "not_found" ? "not_found" : "request_failed";
}
