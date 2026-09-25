import type { PathPaymentInspectorErrorCode } from "@/features/path-payment-inspector/types";

export const copy = {
  formLabel: "Offers or path query",
  formHint: 'JSON, for example: {"view":"offers","account":"G..."} or {"view":"paths","mode":"strict-send","source":"native","destination":{"type":"credit","code":"USDC","issuer":"G..."},"amount":"10"}.',
  submit: "Inspect",
  working: "Loading",
  emptyTitle: "No DEX data loaded",
  emptyDescription: "Inspect an account's open offers or trace a strict-send or strict-receive payment path.",
  resultTitle: "DEX inspection",
  offersTitle: "Open offers",
  pathsTitle: "Candidate paths",
  noOffers: "This account has no open offers.",
  noPaths: "Horizon found no route for this query.",
  liquidityPool: "Liquidity pool",
  orderBook: "Order book",
  network: "Network"
} as const;

export const errorCopy: Record<PathPaymentInspectorErrorCode, { title: string; description: string }> = {
  empty_input: {
    title: "Enter a value first",
    description: "Paste a JSON offers or path query."
  },
  invalid_input: {
    title: "That value is not valid",
    description: "Use valid Stellar addresses, assets, and a positive amount with up to 7 decimal places."
  },
  not_found: {
    title: "Not found",
    description: "Horizon did not find the requested account."
  },
  request_failed: {
    title: "The request did not complete",
    description: "Horizon did not return usable DEX data. Try again shortly."
  }
};
