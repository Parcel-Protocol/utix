import { err, ok, type Result } from "@/core/result/result";
import { normalizeInput } from "@/core/lib/strings";
import type { Sep12FieldsErrorCode, Sep12FieldsInput } from "@/features/sep12-fields/types";

/** Parses raw form input into a validated request, without throwing. */
export function parseSep12FieldsInput(raw: string): Result<Sep12FieldsInput, Sep12FieldsErrorCode> {
  const value = normalizeInput(raw);
  if (!value) return err("empty_input");
  return ok({ value });
}
