import { Sparkles } from "lucide-react";
import type { FeatureManifest } from "@/core/registry/types";

export const manifest: FeatureManifest = {
  slug: "scval-codec",
  title: "ScVal Encoder & Decoder",
  description: "Encode tagged JSON to base64 ScVal or decode a ScVal locally.",
  character: "A Soroban translator turns opaque values into readable, lossless notes.",
  category: "developer",
  status: "working",
  icon: Sparkles,
  networks: ["testnet", "mainnet"],
  keywords: ["scval-codec"]
};
