import { err, ok, type Result } from "@/core/result/result";
import { normalizeInput } from "@/core/lib/strings";
import type { ScvalCodecErrorCode, ScvalCodecInput } from "@/features/scval-codec/types";

/** Parses raw form input into a validated request, without throwing. */
export function parseScvalCodecInput(raw: string): Result<ScvalCodecInput, ScvalCodecErrorCode> {
  const value = normalizeInput(raw);
  if (!value) return err("empty_input");
  return ok({ value });
}
