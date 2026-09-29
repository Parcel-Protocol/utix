import type { SorobanAuthInspectorErrorCode } from "@/features/soroban-auth-inspector/types";

export const errorCopy: Record<
  SorobanAuthInspectorErrorCode,
  { title: string; description: string }
> = {
  empty_input: {
    title: "No input provided",
    description: "Paste a transaction envelope in base64 format to inspect its Soroban authorization entries.",
  },
  invalid_base64: {
    title: "Invalid base64 format",
    description:
      "The input does not appear to be valid base64. Check that you copied the entire envelope correctly.",
  },
  invalid_xdr: {
    title: "Invalid transaction envelope",
    description:
      "The input is valid base64 but does not decode to a transaction envelope. Paste the complete XDR.",
  },
  not_soroban: {
    title: "Not a Soroban invocation",
    description: "This transaction envelope contains no Soroban contract invocation.",
  },
  no_authorization: {
    title: "No authorization entries",
    description:
      "This Soroban invocation declares no authorization entries. The transaction uses only the source account.",
  },
  auth_unreadable: {
    title: "Authorization entry unreadable",
    description:
      "One or more authorization entries in this invocation could not be decoded. The transaction envelope may be malformed.",
  },
};
