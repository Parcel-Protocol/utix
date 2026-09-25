import { FileText } from "lucide-react";
import type { FeatureManifest } from "@/features/manifest";

export const manifest: FeatureManifest = {
  slug: "transaction-decoder",
  title: "Transaction Decoder & Simulator",
  description: "Decode multi-operation transaction envelopes with static effect preview.",
  category: "transactions",
  icon: FileText,
  networks: ["mainnet", "testnet"]
};
