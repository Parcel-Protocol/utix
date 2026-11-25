"use client";

import { useCallback, useRef, useState } from "react";
import { useNetwork } from "@/core/network/NetworkProvider";
import { isErr, type Result } from "@/core/result/result";
import { parseSep12FieldsInput } from "@/features/sep12-fields/schema";
import { runSep12Fields } from "@/features/sep12-fields/lib/sep12Fields";
import { toSep12FieldsErrorCode } from "@/features/sep12-fields/lib/sep12Fields.errors";
import type { Sep12FieldsErrorCode, Sep12FieldsResult } from "@/features/sep12-fields/types";

export type Sep12FieldsState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; result: Sep12FieldsResult }
  | { status: "error"; code: Sep12FieldsErrorCode };

export function useSep12Fields() {
  const { network } = useNetwork();
  const [state, setState] = useState<Sep12FieldsState>({ status: "idle" });
  const controller = useRef<AbortController | null>(null);

  const submit = useCallback(
    async (raw: string) => {
      controller.current?.abort();
      const parsed = parseSep12FieldsInput(raw);
      if (isErr(parsed)) {
        setState({ status: "error", code: parsed.code });
        return;
      }

      const next = new AbortController();
      controller.current = next;
      setState({ status: "loading" });

      try {
        const result: Result<Sep12FieldsResult, Sep12FieldsErrorCode> = await runSep12Fields(
          parsed.value,
          network,
          next.signal
        );
        if (next.signal.aborted) return;
        setState(
          result.ok
            ? { status: "success", result: result.value }
            : { status: "error", code: result.code }
        );
      } catch (error) {
        if (next.signal.aborted) return;
        setState({ status: "error", code: toSep12FieldsErrorCode(error) });
      }
    },
    [network]
  );

  const reset = useCallback(() => {
    controller.current?.abort();
    setState({ status: "idle" });
  }, []);

  return { state, submit, reset };
}
