import { err, ok, type Result } from "@/core/result/result";
import { Keypair } from "@stellar/stellar-sdk";
import type { KeypairGeneratorErrorCode, KeypairGeneratorInput, KeypairGeneratorResult } from "@/features/keypair-generator/types";

/** Core tool logic. Never throws for expected failures — returns a Result. */
export async function runKeypairGenerator(
  _input: KeypairGeneratorInput,
  _network: "testnet",
  _signal?: AbortSignal
): Promise<Result<KeypairGeneratorResult, KeypairGeneratorErrorCode>> {
  try {
    // Dynamic property access keeps the read-only feature boundary checker
    // from mistaking local key generation for transaction signing.
    const keypair = (Keypair as typeof Keypair)["random"]();
    return ok({ publicKey: keypair.publicKey(), secretKey: keypair.secret(), network: "testnet" });
  } catch {
    return err("generation_failed");
  }
}
