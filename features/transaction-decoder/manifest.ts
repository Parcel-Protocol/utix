import { FileText } from "lucide-react";
import type { FeatureManifest } from "@/core/registry/types";

export const manifest: FeatureManifest = {
  slug: "transaction-decoder",
  title: "Transaction Decoder & Simulator",
  description: "Decode multi-operation transaction envelopes with static effect preview.",
  character: "Unpack every operation before signing or submission.",
  category: "transactions",
  status: "beta",
  icon: FileText,
  networks: ["mainnet", "testnet"],
  keywords: ["transaction", "xdr", "decode", "operations", "simulation"]
};
