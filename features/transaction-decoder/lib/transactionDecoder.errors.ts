import type { TransactionDecoderErrorCode } from "@/features/transaction-decoder/types";

export function mapTransactionDecoderError(code: TransactionDecoderErrorCode): string {
  switch (code) {
    case "empty_input":
      return "Please enter a base64-encoded transaction XDR.";
    case "malformed_xdr":
      return "The provided string is not a valid base64 XDR transaction envelope.";
    case "unsupported_envelope":
      return "The transaction envelope format is unsupported.";
    default:
      return "An unexpected error occurred.";
  }
}
