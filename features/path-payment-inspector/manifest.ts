import { Sparkles } from "lucide-react";
import type { FeatureManifest } from "@/core/registry/types";

export const manifest: FeatureManifest = {
  slug: "path-payment-inspector",
  title: "Path Payment and DEX Offer Inspector",
  description: "Inspect account offers and trace strict-send or strict-receive payment paths across the Stellar DEX.",
  character: "A route planner follows every book and pool hop before the payment leaves home.",
  category: "network",
  status: "beta",
  icon: Sparkles,
  networks: ["testnet", "mainnet"],
  keywords: ["path payment", "strict send", "strict receive", "offers", "liquidity pool", "dex"]
};
