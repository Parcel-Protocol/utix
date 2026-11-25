import { Sparkles } from "lucide-react";
import type { FeatureManifest } from "@/core/registry/types";

export const manifest: FeatureManifest = {
  slug: "keypair-generator",
  title: "Testnet Keypair Generator",
  description: "Generate a disposable Stellar testnet keypair locally in your browser.",
  character: "A careful key clerk creates a testnet badge and reminds you to lock away the secret.",
  category: "keys",
  status: "working",
  icon: Sparkles,
  networks: ["testnet", "mainnet"],
  keywords: ["keypair-generator"]
};
