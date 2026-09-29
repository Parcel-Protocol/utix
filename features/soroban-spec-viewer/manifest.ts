import { BookOpen } from "lucide-react";
import type { FeatureManifest } from "@/core/registry/types";

export const manifest: FeatureManifest = {
  slug: "soroban-spec-viewer",
  title: "Soroban Contract Interface Viewer",
  description:
    "Read a deployed contract's interface directly from the chain and view every exported function, argument type, return type, custom types, and error codes.",
  character: "See what a contract offers before you call it.",
  category: "soroban",
  status: "working",
  icon: BookOpen,
  networks: ["mainnet", "testnet"],
  offline: false,
  keywords: [
    "soroban",
    "contract",
    "interface",
    "spec",
    "wasm",
    "function",
    "types",
    "rpc",
  ],
};
