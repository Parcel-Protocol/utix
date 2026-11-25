import { describe, it } from "node:test";
import assert from "node:assert/strict";
import definition from "../orphan-repair-definition.mjs";

describe("checkpointed orphan repair definition", () => {
  it("reconnects only independently verified orphan ownership and is idempotent", () => {
    const original = { id: "ticket-1", ownerId: "", orphaned: true, verifiedOwnerId: "Gverified" };
    const updated = definition.transform(original);
    assert.equal(updated.ok, true);
    assert.deepEqual(updated.value, { ...original, ownerId: "Gverified", orphaned: false });
    assert.deepEqual(definition.transform(updated.value), updated);
    assert.equal(original.orphaned, true);
  });
  it("fails closed for unknown owner or conflicting ownership", () => {
    assert.deepEqual(definition.transform({ id: "ticket-1", orphaned: true }), { ok: false, code: "verified_owner_required" });
    assert.deepEqual(definition.transform({ id: "ticket-2", orphaned: true, ownerId: "A", verifiedOwnerId: "B" }), { ok: false, code: "conflicting_owner_requires_manual_review" });
    assert.deepEqual(definition.transform({ id: "ticket-3", orphaned: "maybe", verifiedOwnerId: "A" }), { ok: false, code: "unverified_orphan_state" });
  });
});
