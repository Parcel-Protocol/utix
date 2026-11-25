export type KeypairGeneratorInput = Record<string, never>;

export interface KeypairGeneratorResult {
  publicKey: string;
  /** The secret exists only in the component state and is never sent to a server. */
  secretKey: string;
  network: "testnet";
}

export type KeypairGeneratorErrorCode = "generation_failed";
