/**
 * Fail-closed destination and content policy for external HTTP deliveries.
 * Safe by default: no outbound host or content type is accepted until declared.
 */
import { err, ok, type Result } from "@/core/result/result";

export type OutboundPolicyError =
  | "destination_not_allowed"
  | "content_not_allowed"
  | "invalid_destination"
  | "payload_too_large";

export interface OutboundAllowlist {
  /** Exact HTTPS origin strings; no wildcards, credentials, paths or query. */
  readonly origins: readonly string[];
  /** Normalized MIME types, without parameters. */
  readonly contentTypes: readonly string[];
  readonly maxBodyBytes?: number;
}

const DEFAULT_MAX_BODY_BYTES = 256 * 1024;
const HOSTNAME = /^(?=.{4,253}$)(?:[a-z0-9-]+\.)+[a-z]{2,}$/i;

function normalizedOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password ||
        url.hash || url.search || (url.pathname !== "/" && url.pathname !== "") ||
        !HOSTNAME.test(url.hostname) || url.hostname.endsWith(".") ||
        url.hostname === "localhost" || url.hostname.endsWith(".localhost") ||
        !url.hostname.includes(".")) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function checkOutboundDelivery(
  destination: string,
  contentType: string,
  body: string | Uint8Array,
  policy: OutboundAllowlist
): Result<{ destination: string; contentType: string }, OutboundPolicyError> {
  let url: URL;
  try {
    url = new URL(destination);
    if (url.protocol !== "https:" || url.username || url.password || url.hash ||
        !HOSTNAME.test(url.hostname) || !url.hostname.includes(".") ||
        url.hostname === "localhost" || url.hostname.endsWith(".localhost") ||
        url.hostname.endsWith(".") || url.hostname.startsWith("127.")) {
      return err("invalid_destination");
    }
  } catch {
    return err("invalid_destination");
  }
  const allowed = policy.origins
    .map(normalizedOrigin)
    .filter((origin): origin is string => origin !== null);
  if (!allowed.includes(url.origin)) return err("destination_not_allowed");
  const type = contentType.split(";", 1)[0].trim().toLowerCase();
  if (!policy.contentTypes.map((value) => value.toLowerCase()).includes(type)) {
    return err("content_not_allowed");
  }
  const cap = policy.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (!Number.isSafeInteger(cap) || cap < 0) return err("payload_too_large");
  const size = typeof body === "string" ? new TextEncoder().encode(body).byteLength : body.byteLength;
  if (size > cap) return err("payload_too_large");
  return ok({ destination: url.toString(), contentType: type });
}
