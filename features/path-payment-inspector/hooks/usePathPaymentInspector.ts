"use client";

import { useCallback, useRef, useState } from "react";
import { useNetwork } from "@/core/network/NetworkProvider";
import { isErr, type Result } from "@/core/result/result";
import { parsePathPaymentInspectorInput } from "@/features/path-payment-inspector/schema";
import { runPathPaymentInspector } from "@/features/path-payment-inspector/lib/pathPaymentInspector";
import { toPathPaymentInspectorErrorCode } from "@/features/path-payment-inspector/lib/pathPaymentInspector.errors";
import type { PathPaymentInspectorErrorCode, PathPaymentInspectorResult } from "@/features/path-payment-inspector/types";

export type PathPaymentInspectorState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; result: PathPaymentInspectorResult }
  | { status: "error"; code: PathPaymentInspectorErrorCode };

export function usePathPaymentInspector() {
  const { network } = useNetwork();
  const [state, setState] = useState<PathPaymentInspectorState>({ status: "idle" });
  const controller = useRef<AbortController | null>(null);

  const submit = useCallback(
    async (raw: string) => {
      controller.current?.abort();
      const parsed = parsePathPaymentInspectorInput(raw);
      if (isErr(parsed)) {
        setState({ status: "error", code: parsed.code });
        return;
      }

      const next = new AbortController();
      controller.current = next;
      setState({ status: "loading" });

      try {
        const result: Result<PathPaymentInspectorResult, PathPaymentInspectorErrorCode> = await runPathPaymentInspector(
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
        setState({ status: "error", code: toPathPaymentInspectorErrorCode(error) });
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
