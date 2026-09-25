import type { Asset } from "@/features/path-payment-inspector/types";

export function formatAsset(asset: Asset): string {
  return asset.type === "native" ? "XLM" : `${asset.code}:${asset.issuer.slice(0, 6)}...`;
}

export function formatRatio(numerator: string | number, denominator: string | number): string {
  const numeratorValue = BigInt(numerator);
  const denominatorValue = BigInt(denominator);
  if (denominatorValue === 0n) return "n/a";
  const negative = numeratorValue < 0n !== denominatorValue < 0n;
  const top = numeratorValue < 0n ? -numeratorValue : numeratorValue;
  const bottom = denominatorValue < 0n ? -denominatorValue : denominatorValue;
  const whole = top / bottom;
  let remainder = top % bottom;
  if (remainder === 0n) return `${negative ? "-" : ""}${whole}`;
  let decimals = "";
  for (let index = 0; index < 18 && remainder !== 0n; index += 1) {
    remainder *= 10n;
    decimals += (remainder / bottom).toString();
    remainder %= bottom;
  }
  return `${negative ? "-" : ""}${whole}.${decimals.replace(/0+$/, "")}`;
}
