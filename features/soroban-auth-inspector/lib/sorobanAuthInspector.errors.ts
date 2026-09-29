import type { SorobanAuthInspectorErrorCode } from "@/features/soroban-auth-inspector/types";

export function toAuthInspectorErrorCode(error: unknown): SorobanAuthInspectorErrorCode {
  if (error instanceof SyntaxError && error.message.includes("Unexpected end of JSON input")) {
    return "invalid_base64";
  }

  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (msg.includes("invalid base64")) return "invalid_base64";
    if (msg.includes("unexpected")) return "invalid_xdr";
  }

  return "invalid_xdr";
}

export function isInputProblem(code: SorobanAuthInspectorErrorCode): boolean {
  return ["empty_input", "invalid_base64", "invalid_xdr"].includes(code);
}
