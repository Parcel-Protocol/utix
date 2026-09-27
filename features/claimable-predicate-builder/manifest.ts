import { Clock } from "lucide-react";
import type { FeatureManifest } from "@/core/registry/types";

export const manifest: FeatureManifest = {
  slug: "claimable-predicate-builder",
  title: "Claimable Balance Predicate Builder",
  description:
    "Build complex claimable balance predicates interactively with natural language preview, unsatisfiability detection, and XDR export.",
  character: "Construct precise claim conditions without fear of locking balances forever.",
  category: "assets",
  status: "beta",
  icon: Clock,
  networks: ["testnet", "mainnet"],
  keywords: ["claimable-predicate-builder", "claimable balance", "predicate", "claimant", "xdr", "timelock"]
};
