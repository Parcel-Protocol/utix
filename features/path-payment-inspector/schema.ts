import { err, ok, type Result } from "@/core/result/result";
import { normalizeInput } from "@/core/lib/strings";
import type { PathPaymentInspectorErrorCode, PathPaymentInspectorInput } from "@/features/path-payment-inspector/types";
import { StrKey } from "@stellar/stellar-sdk";
import type { Asset } from "@/features/path-payment-inspector/types";

function parseAsset(value: unknown): Asset | undefined {
  if (value === "native" || (value && typeof value === "object" && (value as { type?: unknown }).type === "native")) return { type: "native" };
  if (!value || typeof value !== "object") return undefined;
  const asset = value as { type?: unknown; code?: unknown; issuer?: unknown };
  if (asset.type !== "credit" || typeof asset.code !== "string" || !/^[A-Za-z0-9]{1,12}$/.test(asset.code) || typeof asset.issuer !== "string" || !StrKey.isValidEd25519PublicKey(asset.issuer)) return undefined;
  return { type: "credit", code: asset.code, issuer: asset.issuer };
}

function sameAsset(left: Asset, right: Asset): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Parses raw form input into a validated request, without throwing. */
export function parsePathPaymentInspectorInput(raw: string): Result<PathPaymentInspectorInput, PathPaymentInspectorErrorCode> {
  const value = normalizeInput(raw);
  if (!value) return err("empty_input");
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return err("invalid_input"); }
  if (!parsed || typeof parsed !== "object") return err("invalid_input");
  const input = parsed as Record<string, unknown>;
  if (input.view === "offers") {
    if (typeof input.account !== "string" || !StrKey.isValidEd25519PublicKey(input.account)) return err("invalid_input");
    const limit = input.limit === undefined ? 200 : Number(input.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) return err("invalid_input");
    return ok({ view: "offers", account: input.account, limit });
  }
  if (input.view !== "paths" || (input.mode !== "strict-send" && input.mode !== "strict-receive")) return err("invalid_input");
  const source = parseAsset(input.source);
  const destination = parseAsset(input.destination);
  if (!source || !destination || sameAsset(source, destination)) return err("invalid_input");
  if (typeof input.amount !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d{1,7})?$/.test(input.amount) || Number(input.amount) <= 0) return err("invalid_input");
  return ok({ view: "paths", mode: input.mode, source, destination, amount: input.amount });
}
