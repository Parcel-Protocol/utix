/**
 * Small bounded dedupe journal shared by notification and outbound webhook
 * delivery orchestrators. Keep one journal per durable delivery namespace;
 * counters are for observability, never payloads or private addresses.
 */
export interface DeliveryClaim {
  readonly key: string;
  readonly expiresAt: number;
  readonly status: "reserved" | "delivered";
}
export interface DeliveryClaimStore {
  claim(key: string, now: number, ttlMs: number): "claimed" | "duplicate";
  commit(key: string): boolean;
  release(key: string): boolean;
  inspect(): readonly DeliveryClaim[];
}

export function createDeliveryClaimStore(maxEntries = 10_000): DeliveryClaimStore {
  const claims = new Map<string, DeliveryClaim>();
  return {
    claim(key, now, ttlMs) {
      if (!key || key.length > 256 || !Number.isFinite(now) ||
          !Number.isSafeInteger(ttlMs) || ttlMs <= 0) return "duplicate";
      for (const [id, claim] of claims) {
        if (claim.expiresAt <= now) claims.delete(id);
      }
      if (claims.has(key)) return "duplicate";
      // Saturation fails closed rather than evicting live claims and allowing
      // accidental duplicate delivery.
      if (claims.size >= maxEntries) return "duplicate";
      claims.set(key, { key, expiresAt: now + ttlMs, status: "reserved" });
      return "claimed";
    },
    commit(key) {
      const item = claims.get(key);
      if (!item) return false;
      claims.set(key, { ...item, status: "delivered" });
      return true;
    },
    release(key) {
      if (claims.get(key)?.status !== "reserved") return false;
      return claims.delete(key);
    },
    inspect: () => [...claims.values()]
  };
}
