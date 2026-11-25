/**
 * The outbound delivery seam for webhook and notification fan-out.
 * The caller must declare exact destinations and MIME types. A claim is
 * reserved before invoking the sender, and committed only on success.
 */
import { checkOutboundDelivery, type OutboundAllowlist } from "@/core/security/outbound-allowlist";
import { createDeliveryClaimStore, type DeliveryClaimStore } from "@/core/notifications/delivery-dedupe";
import { err, ok, type Result } from "@/core/result/result";

export type DeliveryError =
  | "destination_not_allowed"
  | "content_not_allowed"
  | "invalid_destination"
  | "payload_too_large"
  | "duplicate_delivery"
  | "send_failed";

export interface SafeDeliveryOptions {
  readonly allowlist: OutboundAllowlist;
  readonly claims?: DeliveryClaimStore;
  /** Inject a transport with redirect following DISABLED; never use a redirect target without re-validation. */
  readonly send: (destination: string, contentType: string, body: string) => Promise<boolean>;
  readonly now?: () => number;
  readonly ttlMs?: number;
}

export function createSafeDelivery(options: SafeDeliveryOptions) {
  const claims = options.claims ?? createDeliveryClaimStore();
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? 60 * 60 * 1000;
  return async function deliver(input: {
    readonly recipientKey: string;
    readonly eventId: string;
    readonly destination: string;
    readonly contentType: string;
    readonly body: string;
  }): Promise<Result<{ duplicate: false }, DeliveryError>> {
    const checked = checkOutboundDelivery(input.destination, input.contentType, input.body, options.allowlist);
    if (!checked.ok) return checked;
    if (!input.recipientKey || !input.eventId) return err("duplicate_delivery");
    // Namespace includes recipient and event id. The content of the message
    // never appears in logs, audit receipts or idempotency keys.
    const key = JSON.stringify([input.recipientKey, input.eventId, checked.value.destination]);
    if (claims.claim(key, now(), ttlMs) !== "claimed") return err("duplicate_delivery");
    try {
      const accepted = await options.send(checked.value.destination, checked.value.contentType, input.body);
      if (!accepted) {
        claims.release(key);
        return err("send_failed");
      }
      claims.commit(key);
      return ok({ duplicate: false });
    } catch {
      // Delivery outcome is unknown. Keep the reservation until TTL expires
      // rather than immediately retrying a possibly delivered request.
      return err("send_failed");
    }
  };
}
