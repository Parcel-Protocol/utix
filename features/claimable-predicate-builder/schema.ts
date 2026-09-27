import { err, ok, type Result } from "@/core/result/result";
import { normalizeInput } from "@/core/lib/strings";
import type {
  ClaimablePredicateBuilderErrorCode,
  ClaimablePredicateBuilderInput
} from "@/features/claimable-predicate-builder/types";

/** Parses raw form input into a validated request, without throwing. */
export function parseClaimablePredicateBuilderInput(
  raw: string
): Result<ClaimablePredicateBuilderInput, ClaimablePredicateBuilderErrorCode> {
  const value = normalizeInput(raw);
  if (!value) return err("empty_input");

  if (!/^[A-Za-z0-9+/=]+$/.test(value)) {
    return err("invalid_input");
  }

  return ok({ value });
}
