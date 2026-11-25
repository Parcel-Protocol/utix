import { classifyHorizonError } from "@/core/horizon/errors";
import type { Sep12FieldsErrorCode } from "@/features/sep12-fields/types";

/** Maps transport failures onto this tool's own error codes. */
export function toSep12FieldsErrorCode(error: unknown): Sep12FieldsErrorCode {
  const { code } = classifyHorizonError(error);
  return code === "not_found" ? "not_found" : "request_failed";
}
