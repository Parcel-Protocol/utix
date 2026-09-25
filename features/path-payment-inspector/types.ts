export type Asset =
  | { type: "native" }
  | { type: "credit"; code: string; issuer: string };

export interface PathPaymentInspectorInput {
  view: "offers" | "paths";
  account?: string;
  mode?: "strict-send" | "strict-receive";
  source?: Asset;
  destination?: Asset;
  amount?: string;
  limit?: number;
}

export interface Offer {
  id: string;
  selling: Asset;
  buying: Asset;
  amount: string;
  priceRatio: string;
  priceDecimal: string;
  filled: boolean;
}

export interface PathHop {
  asset: Asset;
  kind: "order_book" | "liquidity_pool";
}

export interface PaymentPath {
  sourceAmount: string;
  destinationAmount: string;
  hops: PathHop[];
}

export interface PathPaymentInspectorResult {
  view: "offers" | "paths";
  network: string;
  offers: Offer[];
  paths: PaymentPath[];
}

export type PathPaymentInspectorErrorCode =
  | "empty_input"
  | "invalid_input"
  | "not_found"
  | "request_failed";
