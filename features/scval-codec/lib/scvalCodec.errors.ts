import { classifyHorizonError } from "@/core/horizon/errors";
import type { ScvalCodecErrorCode } from "@/features/scval-codec/types";

/** Maps transport failures onto this tool's own error codes. */
export function toScvalCodecErrorCode(error: unknown): ScvalCodecErrorCode {
  const { code } = classifyHorizonError(error);
  return code === "not_found" ? "not_found" : "request_failed";
}
