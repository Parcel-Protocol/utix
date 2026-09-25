import { err, ok, type Result } from "@/core/result/result";
import { horizonUrl } from "@/core/horizon/client";
import { formatRatio } from "@/features/path-payment-inspector/lib/format";
import type { StellarNetwork } from "@/core/network/types";
import type { Asset, Offer, PathPaymentInspectorErrorCode, PathPaymentInspectorInput, PathPaymentInspectorResult, PaymentPath } from "@/features/path-payment-inspector/types";

function assetFromHorizon(value: Record<string, unknown>): Asset {
  if (value.asset_type === "native") return { type: "native" };
  return { type: "credit", code: String(value.asset_code), issuer: String(value.asset_issuer) };
}

function queryAsset(asset: Asset): Record<string, string> {
  return asset.type === "native" ? { asset_type: "native" } : { asset_type: "credit_alphanum4", asset_code: asset.code, asset_issuer: asset.issuer };
}

async function getJson(url: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const response = await fetch(url, { signal });
  if (response.status === 404) throw new Error("not_found");
  if (!response.ok) throw new Error(`horizon_${response.status}`);
  return (await response.json()) as Record<string, unknown>;
}

function readOffer(value: Record<string, unknown>): Offer {
  const ratio = (value.price_r ?? {}) as { n?: string | number; d?: string | number };
  const numerator = ratio.n ?? 0;
  const denominator = ratio.d ?? 1;
  const amount = String(value.amount ?? "0");
  return { id: String(value.id), selling: assetFromHorizon(value.selling as Record<string, unknown>), buying: assetFromHorizon(value.buying as Record<string, unknown>), amount, priceRatio: `${numerator}/${denominator}`, priceDecimal: formatRatio(numerator, denominator), filled: value.amount !== value.original_amount && value.original_amount !== undefined };
}

/** Core tool logic. Never throws for expected failures — returns a Result. */
export async function runPathPaymentInspector(
  input: PathPaymentInspectorInput,
  network: StellarNetwork,
  signal?: AbortSignal
): Promise<Result<PathPaymentInspectorResult, PathPaymentInspectorErrorCode>> {
  try {
    if (input.view === "offers") {
      const body = await getJson(horizonUrl(network, `/accounts/${input.account}/offers`, { limit: input.limit }), signal);
      const records = Array.isArray((body._embedded as { records?: unknown[] } | undefined)?.records) ? (body._embedded as { records: unknown[] }).records : [];
      return ok({ view: "offers", network, offers: records.map((record) => readOffer(record as Record<string, unknown>)), paths: [] });
    }
    const sourceQuery = queryAsset(input.source!);
    const destinationQuery = Object.fromEntries(Object.entries(queryAsset(input.destination!)).map(([key, value]) => [`destination_${key}`, value]));
    const amountKey = input.mode === "strict-send" ? "source_amount" : "destination_amount";
    const body = await getJson(horizonUrl(network, `/paths/${input.mode}`, { ...sourceQuery, ...destinationQuery, [amountKey]: input.amount }), signal);
    const records = Array.isArray((body._embedded as { records?: unknown[] } | undefined)?.records) ? (body._embedded as { records: unknown[] }).records : [];
    const paths: PaymentPath[] = records.map((record) => { const value = record as Record<string, unknown>; const path = Array.isArray(value.path) ? value.path : []; return { sourceAmount: String(value.source_amount ?? "0"), destinationAmount: String(value.destination_amount ?? "0"), hops: path.map((hop) => { const asset = hop as Record<string, unknown>; return { asset: assetFromHorizon(asset), kind: asset.liquidity_pool_id ? "liquidity_pool" : "order_book" }; }) }; });
    return ok({ view: "paths", network, offers: [], paths });
  } catch (error) {
    return err(error instanceof Error && error.message === "not_found" ? "not_found" : "request_failed");
  }
}
