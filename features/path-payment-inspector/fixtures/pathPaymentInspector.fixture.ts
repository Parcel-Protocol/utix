import type { PathPaymentInspectorResult } from "@/features/path-payment-inspector/types";
import { Keypair } from "@stellar/stellar-sdk";

const seed = (byte: number) => Keypair.fromRawEd25519Seed(Buffer.alloc(32, byte));
export const accountId = seed(61).publicKey();
export const issuerId = seed(62).publicKey();

export const offersResponse = {
  _embedded: { records: [{ id: "1", selling: { asset_type: "native" }, buying: { asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: issuerId }, amount: "12.5000000", original_amount: "20.0000000", price_r: { n: "1", d: "1000000000000000000" } }] }
};

export const pathsResponse = {
  _embedded: { records: [{ source_amount: "10", destination_amount: "8.25", path: [{ asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: issuerId }, { asset_type: "credit_alphanum4", asset_code: "EURC", asset_issuer: issuerId }, { asset_type: "credit_alphanum4", asset_code: "GBP", asset_issuer: issuerId }] }] }
};

export const poolOnlyResponse = {
  _embedded: { records: [{ source_amount: "10", destination_amount: "9.9", path: [{ asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: issuerId, liquidity_pool_id: "pool-1" }] }] }
};

export const pathPaymentInspectorFixture: PathPaymentInspectorResult = {
  view: "paths",
  network: "testnet",
  offers: [],
  paths: [{ sourceAmount: "10", destinationAmount: "8.25", hops: [{ asset: { type: "credit", code: "USDC", issuer: issuerId }, kind: "order_book" }] }]
};
