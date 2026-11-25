import type { ScvalCodecErrorCode } from "@/features/scval-codec/types";

export const copy = {
  formLabel: "ScVal JSON or base64",
  formHint: 'Encode tagged JSON such as {"type":"u128","value":"42"}, or paste base64 ScVal to decode.',
  submit: "Convert",
  emptyTitle: "No ScVal converted",
  emptyDescription: "Convert locally with the Stellar SDK. Nothing is transmitted.",
  resultTitle: "Conversion result"
} as const;

export const errorCopy: Record<ScvalCodecErrorCode, { title: string; description: string }> = {
  empty_input: { title: "Enter a value first", description: "Paste tagged JSON or base64 ScVal." },
  invalid_input: { title: "That ScVal is not valid", description: "Check the base64 payload or tagged JSON type." },
  unsupported_type: { title: "Unsupported ScVal type", description: "Choose a type supported by the Stellar SDK." }
};
