import { Code } from "lucide-react";
import type { FeatureManifest } from "@/core/registry/types";

export const manifest: FeatureManifest = {
  slug: "soroban-decoder",
  title: "Soroban Contract Invocation Decoder",
  description: "Decode Soroban contract invocation XDRs, inspect ScVal argument trees, and dry-run simulate footprints.",
  character: "Read every contract invocation before it reaches the ledger.",
  category: "soroban",
  status: "beta",
  icon: Code,
  networks: ["mainnet", "testnet"],
  keywords: ["soroban", "contract", "scval", "xdr", "simulation"]
};
