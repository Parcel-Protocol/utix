import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import type { AuditEvent, AuditReceiptSigner, SignedAuditReceipt } from "./audit";

type ReceiptPayload = Omit<AuditEvent, "receipt">;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function payloadFor(event: ReceiptPayload): string {
  const payload = Object.fromEntries(
    Object.entries(event).filter(([key]) => key !== "receipt")
  );
  return canonical(payload);
}

export interface Ed25519AuditSignerOptions {
  readonly signerId: string;
  readonly privateKey: string;
  readonly publicKey: string;
}

export interface Ed25519AuditSigner extends AuditReceiptSigner {
  readonly publicKey: string;
  verify(payload: string, signature: string): boolean;
}

export function createEd25519AuditSigner(options: Ed25519AuditSignerOptions): Ed25519AuditSigner {
  if (!options.signerId.trim()) throw new TypeError("Audit receipt signerId must not be empty");
  const privateKey = createPrivateKey(options.privateKey);
  const publicKey = createPublicKey(options.publicKey);
  const challenge = Buffer.from("utix-ed25519-receipt-key-check", "utf8");
  if (!verify(null, challenge, publicKey, sign(null, challenge, privateKey))) {
    throw new TypeError("Audit receipt public and private keys do not match");
  }
  return {
    signerId: options.signerId,
    publicKey: options.publicKey,
    sign(payload) {
      return sign(null, Buffer.from(payload, "utf8"), privateKey).toString("base64");
    },
    verify(payload, signature) {
      return verify(
        null,
        Buffer.from(payload, "utf8"),
        publicKey,
        Buffer.from(signature, "base64")
      );
    }
  };
}

export function createSignedAuditReceipt(
  event: ReceiptPayload,
  signer: AuditReceiptSigner
): SignedAuditReceipt {
  const payload = payloadFor(event);
  return {
    schemaVersion: "1.0",
    algorithm: "Ed25519",
    signerId: signer.signerId,
    signature: signer.sign(payload)
  };
}

export function verifySignedAuditReceipt(
  event: AuditEvent,
  trustedPublicKeys: Readonly<Record<string, string>>
): boolean {
  const receipt = event.receipt;
  const publicKeyPem =
    receipt && Object.hasOwn(trustedPublicKeys, receipt.signerId)
      ? trustedPublicKeys[receipt.signerId]
      : undefined;
  if (
    !receipt ||
    receipt.schemaVersion !== "1.0" ||
    receipt.algorithm !== "Ed25519" ||
    typeof receipt.signature !== "string" ||
    !publicKeyPem
  ) {
    return false;
  }

  try {
    const publicKey = createPublicKey(publicKeyPem);
    return verify(
      null,
      Buffer.from(payloadFor(event), "utf8"),
      publicKey,
      Buffer.from(receipt.signature, "base64")
    );
  } catch {
    return false;
  }
}
