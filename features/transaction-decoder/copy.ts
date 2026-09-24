import type { TransactionDecoderErrorCode } from "@/features/transaction-decoder/types";

export const copy = {
  title: "Transaction Decoder & Simulator",
  description: "Decode multi-operation Stellar transaction XDR envelopes into per-operation breakdowns with static effect preview.",
  formLabel: "Transaction Envelope XDR",
  formHint: "Paste a base64-encoded TransactionEnvelope or FeeBumpTransactionEnvelope XDR.",
  submit: "Decode Transaction",
  resultTitle: "Decoded Transaction Summary",
  emptyTitle: "No Transaction Decoded",
  emptyDescription: "Paste a transaction envelope XDR above to inspect operations, preconditions, and static analysis.",
  operationsTitle: "Operations Breakdown",
  cancelBadge: "Cancel Offer",
  sponsorshipBadge: "Sponsorship",
  muxedBadge: "Muxed Account",
  staticBadge: "Static Analysis (Read-Only)"
};

export const errorCopy: Record<TransactionDecoderErrorCode, { title: string; description: string }> = {
  empty_input: {
    title: "Empty Input",
    description: "Please provide a valid base64-encoded transaction XDR."
  },
  malformed_xdr: {
    title: "Invalid XDR",
    description: "Unable to parse XDR string into a valid Stellar transaction envelope."
  },
  unsupported_envelope: {
    title: "Unsupported Envelope",
    description: "This envelope type is not supported for decoding."
  }
};
