import { Shield } from "lucide-react";
import type { FeatureManifest } from "@/core/registry/types";

export const manifest: FeatureManifest = {
  slug: "soroban-auth-inspector",
  title: "Soroban Authorization Entry Inspector",
  description:
    "Decode authorization entries attached to a Soroban invocation and render the authorization tree: who must sign, for which sub-invocation, under which nonce and expiry.",
  character: "Unfold the authorization tree and see what each signer actually permits.",
  category: "soroban",
  status: "working",
  icon: Shield,
  networks: [],
  offline: true,
  keywords: [
    "soroban",
    "authorization",
    "xdr",
    "envelope",
    "decode",
    "base64",
    "credentials",
    "nonce",
    "expiry",
  ],
};
