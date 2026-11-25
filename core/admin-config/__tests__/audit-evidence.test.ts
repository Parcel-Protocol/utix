/**
 * Audit evidence for sensitive configuration changes (#admin-config audit evidence)
 *
 * Covers the full evidence chain for every admin-config mutation:
 *   - an evidence bundle is generated from the trail and verifies clean
 *   - a compliance snapshot is captured and its integrity hash survives a re-read
 *   - all four error paths (unauthorized, unknown key, invalid value, audit
 *     rejection) each produce a denied event that lands in the bundle
 *   - retry: a failed attempt followed by a valid one produces two events, only
 *     the second is `allowed`
 *   - idempotent re-apply produces no additional bundle events
 *   - audit-trail rejection blocks both the change and the bundle entry
 *   - snapshot store deduplication: a retried emitter cannot overwrite the
 *     original capture
 *
 * Edge-case and recovery notes
 * ─────────────────────────────
 * • The store applies changes *only after* the audit event is committed. If the
 *   audit trail refuses the event (e.g. storage full, malformed input), the
 *   config is left unchanged and the caller receives `admin_config_audit_rejected`.
 *   Recovery: fix the trail or swap the storage, then reissue the same change.
 *
 * • A compliance snapshot is idempotent: `capture()` returns the first snapshot
 *   for a given event id. A retry that sends the same event id never overwrites
 *   the original record — rollback is impossible only because nothing was written.
 *
 * • `verifyAuditEvidenceBundle` detects post-export tampering via FNV-1a digest.
 *   Any field mutation (count, an event id, a before/after value) fails
 *   verification deterministically.
 *
 * • `verifyComplianceSnapshot` uses SHA-256 over canonical JSON. Key-reordering
 *   attacks do not produce a false positive because canonicalJson sorts keys at
 *   every depth before hashing.
 *
 * Contract preservation
 * ─────────────────────
 * These tests rely only on stable public contracts:
 *   core/audit/audit         — AuditTrail, createIsolatedAuditTrail, recordAudit
 *   core/audit/evidence-bundle — createAuditEvidenceBundle, verifyAuditEvidenceBundle
 *   core/audit/compliance-snapshot — ComplianceSnapshotStore, verifyComplianceSnapshot
 *   core/admin-config/store  — createAdminConfigStore, AdminConfigInput
 *
 * No internal state is inspected; every assertion goes through the public API.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { createIsolatedAuditTrail, type AuditActor } from "@/core/audit";
import { createEd25519AuditSigner } from "@/core/audit/signed-receipt";
import {
  createAuditEvidenceBundle,
  verifyAuditEvidenceBundle
} from "@/core/audit/evidence-bundle";
import {
  ComplianceSnapshotStore,
  verifyComplianceSnapshot,
  type SnapshotStorage
} from "@/core/audit/compliance-snapshot";
import { createAdminConfigStore } from "@/core/admin-config/store";
import type { AdminConfigInput, AdminConfigKey } from "@/core/admin-config/types";

// ── Test infrastructure ───────────────────────────────────────────────────────

class MemorySnapshotStorage implements SnapshotStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

function maintainer(id = "ada"): AuditActor {
  return { kind: "maintainer", id };
}

function user(id = "viewer-1"): AuditActor {
  return { kind: "user", id };
}

const keyPair = generateKeyPairSync("ed25519");
const receiptSigner = createEd25519AuditSigner({
  signerId: "test-admin-signer",
  privateKey: keyPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  publicKey: keyPair.publicKey.export({ type: "spki", format: "pem" }).toString()
});

/**
 * Returns a store wired to a fresh isolated trail and a snapshot store.
 * The record seam writes to both: the trail for query/export, and the
 * snapshot store for integrity verification.
 */
function makeHarness() {
  const trail = createIsolatedAuditTrail();
  const snapshotStorage = new MemorySnapshotStorage();
  const snapshots = new ComplianceSnapshotStore(snapshotStorage);

  const store = createAdminConfigStore({
    receiptSigner,
    record: (input) => {
      const result = trail.record(input);
      if (!result.ok) return undefined;
      const event = result.value;

      // Capture a compliance snapshot for every allowed config change.
      if (event.action === "admin.config_changed" && event.outcome === "allowed") {
        snapshots.capture({
          eventId: event.id,
          event: event.action,
          capturedAt: event.at,
          activeRules: { schemaVersion: "1.0" },
          state: {
            before: event.before ?? null,
            after: event.after ?? null
          }
        });
      }

      return event;
    }
  });

  return { trail, snapshots, store };
}

function changeInput(overrides: Partial<AdminConfigInput> = {}): AdminConfigInput {
  return {
    actor: maintainer(),
    key: "network.endpoint",
    value: "https://horizon-mainnet.stellar.org",
    authorized: true,
    reason: "config_update",
    ...overrides
  };
}

// ── Normal path ───────────────────────────────────────────────────────────────

describe("admin-config audit evidence — normal path", () => {
  let harness: ReturnType<typeof makeHarness>;

  beforeEach(() => { harness = makeHarness(); });

  it("produces one allowed audit event per successful change", () => {
    const { trail, store } = harness;
    const result = store.setConfig(changeInput());

    expect(result.ok).toBe(true);

    const events = trail.all();
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe("admin.config_changed");
    expect(events[0].outcome).toBe("allowed");
    expect(events[0].actor).toEqual({ kind: "maintainer", id: "ada" });
    expect(events[0].scope).toBe("maintainer");
    expect(events[0].target).toEqual({ kind: "admin_config", id: "network.endpoint" });
    expect(events[0].before).toEqual({ "network.endpoint": "https://horizon-testnet.stellar.org" });
    expect(events[0].after).toEqual({ "network.endpoint": "https://horizon-mainnet.stellar.org" });
    expect(typeof events[0].id).toBe("string");
    expect(typeof events[0].at).toBe("string");
  });

  it("evidence bundle wraps every event and verifies clean", () => {
    const { trail, store } = harness;
    store.setConfig(changeInput({ key: "role.default", value: "maintainer", reason: "role_promotion" }));
    store.setConfig(changeInput({ key: "health.checkInterval", value: 120_000, reason: "interval_adjust" }));

    const events = trail.all();
    const bundle = createAuditEvidenceBundle({ events, scope: "maintainer" });

    expect(bundle.schemaVersion).toBe("1.0");
    expect(bundle.scope).toBe("maintainer");
    expect(bundle.eventCount).toBe(2);
    expect(bundle.events).toHaveLength(2);
    expect(verifyAuditEvidenceBundle(bundle)).toBe(true);
  });

  it("compliance snapshot is captured for every allowed change and verifies clean", () => {
    const { trail, snapshots, store } = harness;
    store.setConfig(changeInput());

    const event = trail.all()[0];
    const read = snapshots.read(event.id, "maintainer");

    expect(read.ok).toBe(true);
    if (!read.ok) return;

    expect(read.value.event).toBe("admin.config_changed");
    expect(read.value.eventId).toBe(event.id);
    expect(verifyComplianceSnapshot(read.value)).toEqual({ ok: true, value: true });
  });

  it("compliance snapshot payload embeds the before and after config values", () => {
    const { trail, snapshots, store } = harness;
    store.setConfig(changeInput({ value: "https://horizon-mainnet.stellar.org" }));

    const event = trail.all()[0];
    const read = snapshots.read(event.id, "maintainer");

    expect(read.ok).toBe(true);
    if (!read.ok) return;

    const parsed = JSON.parse(read.value.payload) as {
      state: { before: Record<string, unknown>; after: Record<string, unknown> }
    };
    expect(parsed.state.before).toEqual({ "network.endpoint": "https://horizon-testnet.stellar.org" });
    expect(parsed.state.after).toEqual({ "network.endpoint": "https://horizon-mainnet.stellar.org" });
  });

  it("evidence bundle scope is own when actor is a user (own-scoped events only)", () => {
    const { trail } = harness;
    // Manually emit an own-scoped event to represent a user-visible action.
    trail.record({
      action: "export.generated",
      actor: { kind: "user", id: "account:G1" },
      scope: "own",
      target: { kind: "export_envelope", id: "env-1" }
    });

    const events = trail.all().filter((e) => e.scope === "own");
    const bundle = createAuditEvidenceBundle({ events, scope: "own" });

    expect(bundle.scope).toBe("own");
    expect(bundle.eventCount).toBe(1);
    expect(verifyAuditEvidenceBundle(bundle)).toBe(true);
  });
});

// ── Failure path ──────────────────────────────────────────────────────────────

describe("admin-config audit evidence — failure path", () => {
  let harness: ReturnType<typeof makeHarness>;

  beforeEach(() => { harness = makeHarness(); });

  it("records a denied event for an unknown key and includes it in the bundle", () => {
    const { trail, store } = harness;
    const result = store.setConfig(changeInput({ key: "bogus.key" as AdminConfigKey, value: "x" }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("admin_config_unknown_key");

    const events = trail.all();
    expect(events).toHaveLength(1);
    expect(events[0].outcome).toBe("denied");
    expect(events[0].errorCode).toBe("admin_config_unknown_key");

    const bundle = createAuditEvidenceBundle({ events, scope: "maintainer" });
    expect(verifyAuditEvidenceBundle(bundle)).toBe(true);
    expect(bundle.events[0].outcome).toBe("denied");
  });

  it("records a denied event for an invalid value and excludes it from compliance snapshots", () => {
    const { trail, snapshots, store } = harness;
    store.setConfig(changeInput({ value: "ftp://insecure.example" }));

    const event = trail.all()[0];
    expect(event.outcome).toBe("denied");
    expect(event.errorCode).toBe("admin_config_invalid_value");

    // No compliance snapshot for denied events.
    const read = snapshots.read(event.id, "maintainer");
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.code).toBe("snapshot_not_found");
  });

  it("records a denied event for a credential-bearing URL", () => {
    const { trail, store } = harness;
    store.setConfig(changeInput({ value: "https://user:pass@horizon.example" }));

    const event = trail.all()[0];
    expect(event.outcome).toBe("denied");
    expect(event.errorCode).toBe("admin_config_invalid_value");
  });

  it("does not apply the change and does not emit a bundle entry when the trail rejects the event", () => {
    // Simulate a trail that always rejects (e.g. storage full).
    const store = createAdminConfigStore({ receiptSigner, record: () => undefined });
    const result = store.setConfig(changeInput());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("admin_config_audit_rejected");

    // The config remains at the default; nothing to put in a bundle.
    expect(store.getConfig()["network.endpoint"]).toBe("https://horizon-testnet.stellar.org");
  });

  it("evidence bundle digest detects post-export tampering", () => {
    const { trail, store } = harness;
    store.setConfig(changeInput());

    const events = trail.all();
    const bundle = createAuditEvidenceBundle({ events, scope: "maintainer" });

    // Tamper: change the outcome of the first event in the bundle copy.
    const tampered = {
      ...bundle,
      events: bundle.events.map((e, i) =>
        i === 0 ? { ...e, outcome: "denied" as const } : e
      )
    };

    expect(verifyAuditEvidenceBundle(tampered)).toBe(false);
  });

  it("evidence bundle digest detects a changed event count", () => {
    const { trail, store } = harness;
    store.setConfig(changeInput());

    const bundle = createAuditEvidenceBundle({ events: trail.all(), scope: "maintainer" });
    const tampered = { ...bundle, eventCount: 99 };

    expect(verifyAuditEvidenceBundle(tampered)).toBe(false);
  });
});

// ── Retry path ────────────────────────────────────────────────────────────────

describe("admin-config audit evidence — retry path", () => {
  let harness: ReturnType<typeof makeHarness>;

  beforeEach(() => { harness = makeHarness(); });

  it("failed attempt followed by a valid one: bundle contains both events, only second is allowed", () => {
    const { trail, store } = harness;

    // First attempt — invalid value.
    store.setConfig(changeInput({ value: "javascript:alert(1)" }));
    // Retry — valid value.
    store.setConfig(changeInput({ value: "https://horizon-mainnet.stellar.org" }));

    const events = trail.all();
    expect(events).toHaveLength(2);
    expect(events[0].outcome).toBe("denied");
    expect(events[1].outcome).toBe("allowed");

    const bundle = createAuditEvidenceBundle({ events, scope: "maintainer" });
    expect(bundle.eventCount).toBe(2);
    expect(verifyAuditEvidenceBundle(bundle)).toBe(true);
  });

  it("compliance snapshot is only captured once — for the successful retry", () => {
    const { trail, snapshots, store } = harness;

    store.setConfig(changeInput({ value: "ftp://bad.example" })); // denied
    store.setConfig(changeInput({ value: "https://horizon-mainnet.stellar.org" })); // allowed

    const allowedEvent = trail.all().find((e) => e.outcome === "allowed")!;
    const deniedEvent = trail.all().find((e) => e.outcome === "denied")!;

    expect(snapshots.read(allowedEvent.id, "maintainer").ok).toBe(true);
    expect(snapshots.read(deniedEvent.id, "maintainer").ok).toBe(false);
  });

  it("idempotent re-apply: second call is a no-op and adds no event to the bundle", () => {
    const { trail, store } = harness;

    store.setConfig(changeInput({ value: "https://horizon-mainnet.stellar.org" }));
    const countAfterFirst = trail.all().length;

    // Same value again — idempotent success, no audit event emitted.
    const second = store.setConfig(changeInput({ value: "https://horizon-mainnet.stellar.org" }));
    expect(second.ok).toBe(true);
    expect(trail.all()).toHaveLength(countAfterFirst);
  });

  it("compliance snapshot deduplication: retried emitter with same event id returns the original", () => {
    const { trail, snapshots, store } = harness;

    store.setConfig(changeInput());
    const event = trail.all()[0];

    // The snapshot for this event id already exists; a second capture is ignored.
    const firstCapture = snapshots.read(event.id, "maintainer");
    expect(firstCapture.ok).toBe(true);

    const duplicateCapture = snapshots.capture({
      eventId: event.id,
      event: "admin.config_changed",
      capturedAt: "2099-01-01T00:00:00.000Z", // different timestamp
      activeRules: { schemaVersion: "2.0" },   // different rules
      state: { before: null, after: null }      // different state
    });

    expect(duplicateCapture.ok).toBe(true);
    if (!duplicateCapture.ok || !firstCapture.ok) return;

    // Original payload is preserved — the retried emitter cannot overwrite it.
    expect(duplicateCapture.value.payload).toBe(firstCapture.value.payload);
    expect(duplicateCapture.value.capturedAt).toBe(event.at);
  });
});

// ── Authorization path ────────────────────────────────────────────────────────

describe("admin-config audit evidence — authorization path", () => {
  let harness: ReturnType<typeof makeHarness>;

  beforeEach(() => { harness = makeHarness(); });

  it("records a denied event when authorized flag is false (user-role caller)", () => {
    const { trail, store } = harness;
    const result = store.setConfig(
      changeInput({ actor: user("viewer-1"), authorized: false })
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("admin_config_not_allowed");

    const events = trail.all();
    expect(events).toHaveLength(1);
    expect(events[0].outcome).toBe("denied");
    expect(events[0].errorCode).toBe("admin_config_not_allowed");
    expect(events[0].actor).toEqual({ kind: "user", id: "viewer-1" });
  });

  it("records a denied event when a service account is not authorized", () => {
    const { trail, store } = harness;
    const result = store.setConfig(
      changeInput({ actor: { kind: "system", id: "cron" }, authorized: false })
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("admin_config_not_allowed");

    expect(trail.all()[0].errorCode).toBe("admin_config_not_allowed");
  });

  it("compliance snapshot is not captured for denied authorization attempts", () => {
    const { trail, snapshots, store } = harness;
    store.setConfig(changeInput({ actor: user(), authorized: false }));

    const event = trail.all()[0];
    expect(event.outcome).toBe("denied");
    expect(snapshots.read(event.id, "maintainer").ok).toBe(false);
  });

  it("compliance snapshot read is denied to the own scope regardless of event id", () => {
    const { trail, snapshots, store } = harness;
    store.setConfig(changeInput());

    const event = trail.all()[0];
    const result = snapshots.read(event.id, "own");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("audit_denied");
  });

  it("evidence bundle can be queried by a maintainer but own-scope users see no config events", () => {
    const { trail, store } = harness;
    store.setConfig(changeInput());

    // A maintainer query returns the config event.
    const maintainerPage = trail.query({ kind: "maintainer", id: "ada" });
    expect(maintainerPage.ok).toBe(true);
    if (!maintainerPage.ok) return;
    expect(maintainerPage.value.total).toBe(1);

    // A user query returns nothing (config events are maintainer-scoped).
    const userPage = trail.query({ kind: "user", id: "viewer-1" });
    expect(userPage.ok).toBe(true);
    if (!userPage.ok) return;
    expect(userPage.value.total).toBe(0);
  });

  it("two different maintainers each produce a separate attributed denied event in the bundle", () => {
    const { trail, store } = harness;

    store.setConfig(changeInput({ actor: maintainer("ada"), authorized: false }));
    store.setConfig(changeInput({ actor: maintainer("bob"), authorized: false }));

    const events = trail.all();
    expect(events).toHaveLength(2);
    expect(events[0].actorId).toBe("ada");
    expect(events[1].actorId).toBe("bob");

    const bundle = createAuditEvidenceBundle({ events, scope: "maintainer" });
    expect(bundle.eventCount).toBe(2);
    expect(verifyAuditEvidenceBundle(bundle)).toBe(true);
  });
});

// ── Edge cases ────────────────────────────────────────────────────────────────

describe("admin-config audit evidence — edge cases", () => {
  let harness: ReturnType<typeof makeHarness>;

  beforeEach(() => { harness = makeHarness(); });

  it("evidence bundle from an empty event set is valid and has digest", () => {
    const bundle = createAuditEvidenceBundle({ events: [], scope: "maintainer" });
    expect(bundle.eventCount).toBe(0);
    expect(typeof bundle.digest).toBe("string");
    expect(bundle.digest.length).toBeGreaterThan(0);
    expect(verifyAuditEvidenceBundle(bundle)).toBe(true);
  });

  it("evidence bundle preserves event ordering (chronological insert order)", () => {
    const { trail, store } = harness;

    store.setConfig(changeInput({ key: "network.endpoint", value: "https://a.example", reason: "config_update" }));
    store.setConfig(changeInput({ key: "network.passphrase", value: "My Network ; 2026", reason: "config_update" }));
    store.setConfig(changeInput({ key: "health.checkInterval", value: 90_000, reason: "interval_adjust" }));

    const events = trail.all();
    const bundle = createAuditEvidenceBundle({ events, scope: "maintainer" });

    expect(bundle.events.map((e) => e.target.id)).toEqual([
      "network.endpoint",
      "network.passphrase",
      "health.checkInterval"
    ]);
    expect(verifyAuditEvidenceBundle(bundle)).toBe(true);
  });

  it("compliance snapshot hash is stable across two separate captures with identical input", () => {
    const storage1 = new MemorySnapshotStorage();
    const storage2 = new MemorySnapshotStorage();
    const snapshots1 = new ComplianceSnapshotStore(storage1);
    const snapshots2 = new ComplianceSnapshotStore(storage2);

    const input = {
      eventId: "evt-stable",
      event: "admin.config_changed" as const,
      capturedAt: "2026-11-19T00:00:00.000Z",
      activeRules: { schemaVersion: "1.0" },
      state: { before: { "network.endpoint": "https://a.example" }, after: { "network.endpoint": "https://b.example" } }
    };

    const a = snapshots1.capture(input);
    const b = snapshots2.capture(input);

    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    expect(a.value.integrityHash).toBe(b.value.integrityHash);
    expect(verifyComplianceSnapshot(a.value)).toEqual({ ok: true, value: true });
  });

  it("compliance snapshot payload does not expose a secret embedded in the config value", () => {
    // The store validates values before recording, so a credential-bearing URL
    // is refused before it can reach the snapshot.  This confirms the guard works.
    const { trail, snapshots, store } = harness;

    const result = store.setConfig(changeInput({ value: "https://user:secret@horizon.example" }));
    expect(result.ok).toBe(false);

    // No snapshot should exist for this denied event.
    const event = trail.all()[0];
    expect(event.outcome).toBe("denied");
    expect(snapshots.read(event.id, "maintainer").ok).toBe(false);
  });

  it("evidence bundle round-trips through JSON.stringify / JSON.parse without losing integrity", () => {
    const { trail, store } = harness;
    store.setConfig(changeInput());

    const bundle = createAuditEvidenceBundle({ events: trail.all(), scope: "maintainer" });
    const serialised = JSON.stringify(bundle);
    const restored = JSON.parse(serialised);

    expect(verifyAuditEvidenceBundle(restored)).toBe(true);
  });
});
