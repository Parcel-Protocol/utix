import { Link } from "lucide-react";
import type { FeatureManifest } from "@/core/registry/types";

export const manifest: FeatureManifest = {
  slug: "explorer-links",
  title: "Multi-Explorer Link Generator",
  description:
    "Paste any Stellar identifier and get direct links to view it on every major explorer for your selected network.",
  character: "Find your data on any explorer in one click.",
  category: "utilities",
  status: "working",
  icon: Link,
  networks: ["mainnet", "testnet"],
  offline: true,
  keywords: [
    "explorer",
    "link",
    "account",
    "transaction",
    "ledger",
    "asset",
    "contract",
    "stellar.expert",
    "stellar.chain.com",
  ],
};
