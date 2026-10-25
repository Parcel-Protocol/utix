import { Sparkles } from "lucide-react";
import type { FeatureManifest } from "@/core/registry/types";

export const manifest: FeatureManifest = {
  slug: "sep12-fields",
  title: "SEP-12 KYC Fields",
  description: "Search the standard SEP-9 and SEP-12 KYC field names and types.",
  character: "A compliance librarian finds the exact field name an anchor expects.",
  category: "standards",
  status: "working",
  icon: Sparkles,
  networks: ["testnet", "mainnet"],
  keywords: ["sep12-fields"]
};
