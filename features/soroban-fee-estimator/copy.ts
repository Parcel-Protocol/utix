import type { SorobanFeeEstimatorErrorCode } from "@/features/soroban-fee-estimator/types";

export const errorCopy: Record<
  SorobanFeeEstimatorErrorCode,
  { title: string; description: string }
> = {
  empty_input: {
    title: "No transaction provided",
    description: "Paste a transaction envelope in base64 format to estimate its Soroban resource fees.",
  },
  invalid_base64: {
    title: "Invalid base64 format",
    description: "The input does not appear to be valid base64. Check that you copied the entire envelope.",
  },
  invalid_xdr: {
    title: "Invalid transaction envelope",
    description: "Valid base64 but not a recognized transaction envelope format.",
  },
  not_soroban: {
    title: "Not a Soroban transaction",
    description: "This transaction contains no Soroban invocation or resource declarations.",
  },
  no_resources: {
    title: "No resource declarations",
    description: "This Soroban transaction declares no resource requirements.",
  },
  pricing_unavailable: {
    title: "Current pricing unavailable",
    description:
      "Could not fetch current network pricing from the RPC endpoint. Try again or check the network.",
  },
  rpc_error: {
    title: "RPC endpoint error",
    description: "The Soroban RPC endpoint returned an error. Try again or select a different network.",
  },
  request_failed: {
    title: "Network request failed",
    description: "Could not connect to the RPC endpoint. Check your network connection.",
  },
};
