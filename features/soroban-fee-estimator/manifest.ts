import { DollarSign } from "lucide-react";
import type { FeatureManifest } from "@/core/registry/types";

export const manifest: FeatureManifest = {
  slug: "soroban-fee-estimator",
  title: "Soroban Resource Fee Estimator",
  description:
    "Calculate the exact resource fee for a Soroban transaction, broken down by instruction, memory, ledger read/write, and rent costs.",
  character: "See which resource cost dominates and why your transaction's fee matters.",
  category: "soroban",
  status: "working",
  icon: DollarSign,
  networks: ["mainnet", "testnet"],
  offline: false,
  keywords: [
    "soroban",
    "fees",
    "resources",
    "cpu",
    "memory",
    "ledger",
    "rent",
    "pricing",
    "rpc",
  ],
};
