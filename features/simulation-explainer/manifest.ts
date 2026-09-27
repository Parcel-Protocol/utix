import { Cpu } from "lucide-react";
import type { FeatureManifest } from "@/core/registry/types";

export const manifest: FeatureManifest = {
  slug: "simulation-explainer",
  title: "Soroban Simulation Result Explainer",
  description:
    "Simulate Soroban transaction envelopes against RPC and explain resource usage, fees, state footprint changes, and failures in plain language.",
  character: "Simulation tells you how a contract will run before you pay for it. I make sense of the response.",
  category: "soroban",
  status: "beta",
  icon: Cpu,
  networks: ["testnet", "mainnet"],
  keywords: ["simulation-explainer", "soroban", "simulation", "rpc", "resources", "footprint", "simulateTransaction"]
};
