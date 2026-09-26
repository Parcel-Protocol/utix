import type { SorobanDecoderErrorCode } from "@/features/soroban-decoder/types";

export function mapSorobanDecoderError(code: SorobanDecoderErrorCode): string {
  switch (code) {
    case "empty_input":
      return "Please enter a base64-encoded Soroban XDR or ScVal string.";
    case "malformed_xdr":
      return "The provided string is not a valid base64 XDR or ScVal format.";
    case "unsupported_envelope":
      return "The envelope variant is unsupported for Soroban decoding.";
    default:
      return "An unexpected error occurred.";
  }
}
