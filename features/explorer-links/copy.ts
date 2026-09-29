import type { ExplorerLinksErrorCode } from "@/features/explorer-links/types";

export const errorCopy: Record<
  ExplorerLinksErrorCode,
  { title: string; description: string }
> = {
  empty_input: {
    title: "No identifier provided",
    description: "Paste a Stellar identifier: account (G...), transaction (64 hex), ledger number, asset (code:issuer), or contract (C...).",
  },
  unknown_identifier: {
    title: "Unknown identifier format",
    description:
      "This doesn't match any known Stellar identifier format. Check the format and try again.",
  },
};
