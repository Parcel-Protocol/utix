import { classifyHorizonError } from "@/core/horizon/errors";
import type { PathPaymentInspectorErrorCode } from "@/features/path-payment-inspector/types";

/** Maps transport failures onto this tool's own error codes. */
export function toPathPaymentInspectorErrorCode(error: unknown): PathPaymentInspectorErrorCode {
  const { code } = classifyHorizonError(error);
  return code === "not_found" ? "not_found" : "request_failed";
}
