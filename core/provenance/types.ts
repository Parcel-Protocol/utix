// Provenance types and utilities
export interface ProvenanceInfo {
  recordHash: string;
  signature: string; // base64‑encoded signature
  signerId: string;
  timestamp: string; // ISO‑8601
}

// Simple signing utility (placeholder). In a real implementation this would
// delegate to a key‑management service or use a server‑side private key.
export function signRecord(hash: string, signerId: string): string {
  // Very naive “signature” – just base64 of hash + signer for illustration.
  const payload = `${hash}:${signerId}`;
  return Buffer.from(payload).toString('base64');
}

export function verifySignature(info: ProvenanceInfo): boolean {
  const expected = signRecord(info.recordHash, info.signerId);
  return expected === info.signature;
}
