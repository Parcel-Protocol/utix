import type { ClaimablePredicateBuilderErrorCode } from "@/features/claimable-predicate-builder/types";

export class ClaimablePredicateBuilderError extends Error {
  readonly code: ClaimablePredicateBuilderErrorCode;

  constructor(code: ClaimablePredicateBuilderErrorCode, message: string) {
    super(message);
    this.name = "ClaimablePredicateBuilderError";
    this.code = code;
  }
}

export function toClaimablePredicateBuilderErrorCode(
  error: unknown
): ClaimablePredicateBuilderErrorCode {
  if (error instanceof ClaimablePredicateBuilderError) {
    return error.code;
  }
  return "invalid_input";
}
