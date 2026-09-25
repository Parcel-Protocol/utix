import { Card, CardHeader, CardTitle } from "@/core/ui/Card";
import { DataList } from "@/core/ui/DataList";
import { copy } from "@/features/path-payment-inspector/copy";
import { formatAsset } from "@/features/path-payment-inspector/lib/format";
import type { PathPaymentInspectorResult as PathPaymentInspectorResultValue } from "@/features/path-payment-inspector/types";

export function PathPaymentInspectorResult({ result }: { result: PathPaymentInspectorResultValue }) {
  return <div className="space-y-4">
    <Card><CardHeader><CardTitle>{copy.resultTitle}</CardTitle></CardHeader><DataList items={[{ label: copy.network, value: result.network }]} /></Card>
    {result.view === "offers" ? <Card><CardHeader><CardTitle>{copy.offersTitle}</CardTitle></CardHeader>{result.offers.length === 0 ? <p>{copy.noOffers}</p> : <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr><th className="px-2 py-1">Selling</th><th className="px-2 py-1">Buying</th><th className="px-2 py-1">Amount</th><th className="px-2 py-1">Price</th><th className="px-2 py-1">Status</th></tr></thead><tbody>{result.offers.map((offer) => <tr className="border-t" key={offer.id}><td className="px-2 py-1">{formatAsset(offer.selling)}</td><td className="px-2 py-1">{formatAsset(offer.buying)}</td><td className="px-2 py-1 font-mono">{offer.amount}</td><td className="px-2 py-1 font-mono" title={offer.priceDecimal}>{offer.priceRatio}</td><td className="px-2 py-1">{offer.filled ? "Partially filled" : "Open"}</td></tr>)}</tbody></table></div>}</Card> : <Card><CardHeader><CardTitle>{copy.pathsTitle}</CardTitle></CardHeader>{result.paths.length === 0 ? <p>{copy.noPaths}</p> : <div className="space-y-3">{result.paths.map((path, index) => <div className="border-t pt-3" key={`${path.sourceAmount}-${index}`}><DataList items={[{ label: "Source amount", value: path.sourceAmount, mono: true }, { label: "Destination amount", value: path.destinationAmount, mono: true }, { label: "Hops", value: path.hops.length ? path.hops.map((hop) => `${formatAsset(hop.asset)} (${hop.kind === "liquidity_pool" ? copy.liquidityPool : copy.orderBook})`).join(" -> ") : "Direct" }]} /></div>)}</div>}</Card>}
  </div>;
}
