"use client";

import { useCallback, useRef, useState } from "react";
import { useNetwork } from "@/core/network/NetworkProvider";
import { isErr, type Result } from "@/core/result/result";
import { parseKeypairGeneratorInput } from "@/features/keypair-generator/schema";
import { runKeypairGenerator } from "@/features/keypair-generator/lib/keypairGenerator";
import { toKeypairGeneratorErrorCode } from "@/features/keypair-generator/lib/keypairGenerator.errors";
import type { KeypairGeneratorErrorCode, KeypairGeneratorResult } from "@/features/keypair-generator/types";

export type KeypairGeneratorState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; result: KeypairGeneratorResult }
  | { status: "error"; code: KeypairGeneratorErrorCode };

export function useKeypairGenerator() {
  const { network } = useNetwork();
  const [state, setState] = useState<KeypairGeneratorState>({ status: "idle" });
  const controller = useRef<AbortController | null>(null);

  const submit = useCallback(
    async (raw: string) => {
      controller.current?.abort();
      const parsed = parseKeypairGeneratorInput(raw);
      if (isErr(parsed)) {
        setState({ status: "error", code: parsed.code });
        return;
      }

      const next = new AbortController();
      controller.current = next;
      setState({ status: "loading" });

      try {
        const result: Result<KeypairGeneratorResult, KeypairGeneratorErrorCode> = await runKeypairGenerator(
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
        setState({ status: "error", code: toKeypairGeneratorErrorCode(error) });
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
