/**
 * A narrow, idempotent orphan-repair definition for scripts/backfill.mjs.
 * Only records with an independently verified owner can be reconnected.
 * No Stellar ledger entries, signing keys, or on-chain ownership are touched.
 *
 * Input JSON rows: { id, ownerId, orphaned, verifiedOwnerId }.
 * verifiedOwnerId MUST come from an authoritative source, not a guess.
 */
export default {
  id: "orphan-owner-repair",
  version: "1",
  transform(record) {
    if (!record || typeof record.id !== "string" || !record.id) {
      return { ok: false, code: "invalid_record" };
    }
    if (record.orphaned === false) return { ok: true, value: record };
    if (record.orphaned !== true) return { ok: false, code: "unverified_orphan_state" };
    if (typeof record.verifiedOwnerId !== "string" || !record.verifiedOwnerId.trim()) {
      return { ok: false, code: "verified_owner_required" };
    }
    if (typeof record.ownerId === "string" && record.ownerId &&
        record.ownerId !== record.verifiedOwnerId) {
      return { ok: false, code: "conflicting_owner_requires_manual_review" };
    }
    return {
      ok: true,
      value: { ...record, ownerId: record.verifiedOwnerId, orphaned: false }
    };
  }
};
