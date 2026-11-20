import type { KeypairGeneratorErrorCode } from "@/features/keypair-generator/types";

export const copy = {
  formLabel: "Testnet keypair",
  formHint: "Generated locally with your browser's cryptographically secure random source.",
  submit: "Generate keypair",
  emptyTitle: "No keypair generated",
  emptyDescription: "Create a disposable testnet account for development. Never fund or reuse this key outside testnet.",
  resultTitle: "Testnet keypair"
} as const;

export const errorCopy: Record<KeypairGeneratorErrorCode, { title: string; description: string }> = {
  generation_failed: {
    title: "Could not generate a keypair",
    description: "Your browser could not provide secure randomness. Try again or use another browser."
  }
};
