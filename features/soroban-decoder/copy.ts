import type { SorobanDecoderErrorCode } from "@/features/soroban-decoder/types";

export const copy = {
  title: "Soroban Contract Invocation Decoder",
  description: "Decode Soroban contract invocation XDRs, inspect ScVal argument trees, and dry-run simulate transaction footprints.",
  formLabel: "Soroban Transaction / ScVal XDR",
  formHint: "Paste base64-encoded Soroban transaction envelope, HostFunction XDR, or raw ScVal.",
  submit: "Decode & Simulate",
  resultTitle: "Decoded Soroban Invocation Summary",
  emptyTitle: "No Soroban Invocation Decoded",
  emptyDescription: "Paste a Soroban contract invocation XDR to inspect function arguments, contract spec resolution, and simulation estimates.",
  argsTitle: "Arguments Breakdown (ScVal Tree)",
  simulationTitle: "Read-Only Simulation Estimates",
  specAvailable: "Contract Spec Resolved",
  specFallback: "Generic ScVal Tree (No Spec)"
};

export const errorCopy: Record<SorobanDecoderErrorCode, { title: string; description: string }> = {
  empty_input: {
    title: "Empty Input",
    description: "Please provide a valid base64-encoded Soroban XDR string."
  },
  malformed_xdr: {
    title: "Invalid XDR",
    description: "Unable to parse string into a valid Soroban XDR or ScVal tree."
  },
  unsupported_envelope: {
    title: "Unsupported Envelope",
    description: "This envelope or ScVal structure is not supported."
  }
};
