import { Code } from "lucide-react";
import type { FeatureManifest } from "@/features/manifest";

export const manifest: FeatureManifest = {
  slug: "soroban-decoder",
  title: "Soroban Contract Invocation Decoder",
  description: "Decode Soroban contract invocation XDRs, inspect ScVal argument trees, and dry-run simulate footprints.",
  category: "contracts",
  icon: Code,
  networks: ["mainnet", "testnet"]
};
