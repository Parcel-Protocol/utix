import type { StellarNetwork as Network } from "@/core/network/types";

export type TransactionDecoderErrorCode = "empty_input" | "malformed_xdr" | "unsupported_envelope";

export interface DecodedOperation {
  index: number;
  type: string;
  sourceAccount: string | null;
  isCancelOffer: boolean;
  isSponsorship: boolean;
  isMuxedDestination: boolean;
  labels: string[];
  details: Record<string, unknown>;
}

export interface DecodedTransactionResult {
  sourceAccount: string;
  sequence: string;
  fee: string;
  memo: { type: string; value: string | null };
  preconditions: {
    timeBounds: { minTime: string; maxTime: string } | null;
    ledgerBounds: { minLedger: number; maxLedger: number } | null;
    minSequenceNumber: string | null;
    minSequenceAge: string | null;
    minSequenceLedgerGap: number | null;
    extraSignerCount: number;
  };
  signatureCount: number;
  operations: DecodedOperation[];
  operationCount: number;
  confidenceBadge: "static_analysis" | "best_effort";
  network: Network;
}
