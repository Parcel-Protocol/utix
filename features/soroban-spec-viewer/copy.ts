import type { SorobanSpecViewerErrorCode } from "@/features/soroban-spec-viewer/types";

export const errorCopy: Record<
  SorobanSpecViewerErrorCode,
  { title: string; description: string }
> = {
  empty_input: {
    title: "No contract address provided",
    description: "Enter a Soroban contract address to view its interface.",
  },
  invalid_address: {
    title: "Invalid contract address",
    description: "Contract addresses must start with 'C' and be valid base32.",
  },
  network_error: {
    title: "Network error",
    description: "Could not connect to the RPC endpoint. Check your network connection.",
  },
  contract_not_found: {
    title: "Contract not found",
    description: "This contract address does not exist on the selected network.",
  },
  spec_not_available: {
    title: "Spec not available",
    description:
      "This contract does not have a readable specification. The WASM may not include spec entries.",
  },
  spec_unreadable: {
    title: "Spec unreadable",
    description: "The contract spec entries could not be decoded. The contract WASM may be corrupted.",
  },
  rpc_error: {
    title: "RPC error",
    description: "The Soroban RPC endpoint returned an error. Try again or check the network.",
  },
};
