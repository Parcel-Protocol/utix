import { generateKeyPairSync } from "node:crypto";
import { describe, it, expect } from "vitest";
import { createIsolatedAuditTrail } from "../audit";
import { createEd25519AuditSigner, verifySignedAuditReceipt } from "../signed-receipt";
import { recordSignedAdminChange } from "../admin-receipts";

const change = {
  target: { kind: "service", id: "configuration" },
  before: { mode: "normal" },
  after: { mode: "maintenance" },
  reason: "manual_maintenance",
  correlationId: "corr-admin-1"
};

describe("signed admin audit changes", () => {
  it("signs sanitized admin changes and verifies detached signatures", () => {
    const keys = generateKeyPairSync("ed25519");
    const pub = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
    const signer = createEd25519AuditSigner({ signerId: "maintainer-key-1",
      privateKey: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), publicKey: pub });
    const trail = createIsolatedAuditTrail();
    const result = recordSignedAdminChange(trail, { role: "maintainer", userId: "ada" }, signer, change, { "maintainer-key-1": pub });
    expect(result.ok).toBe(true);
    if (!result.ok) throw Error("signature expected");
    expect(verifySignedAuditReceipt(result.value, { "maintainer-key-1": pub })).toBe(true);
    expect(verifySignedAuditReceipt({ ...result.value, after: { mode: "paused" } }, { "maintainer-key-1": pub })).toBe(false);
    expect(trail.all()).toHaveLength(1);
    expect(trail.all()[0].correlationId).toBe("corr-admin-1");
  });

  it("refuses viewer or missing identity and does not append an unsigned record", () => {
    const keys = generateKeyPairSync("ed25519");
    const pub = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
    const signer = createEd25519AuditSigner({ signerId: "maintainer-key-1",
      privateKey: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), publicKey: pub });
    const trail = createIsolatedAuditTrail();
    expect(recordSignedAdminChange(trail, { role: "viewer", userId: "ada" }, signer, change, { "maintainer-key-1": pub })).toMatchObject({ ok: false, code: "unauthorized" });
    expect(recordSignedAdminChange(trail, { role: "maintainer" }, signer, change, { "maintainer-key-1": pub })).toMatchObject({ ok: false, code: "unauthorized" });
    expect(recordSignedAdminChange(trail, { role: "maintainer", userId: "ada" }, signer, change, {})).toMatchObject({ ok: false, code: "signing_failed" });
    expect(trail.all()).toHaveLength(0);
  });
});
