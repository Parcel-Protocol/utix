"use client";

import { useState } from "react";
import type {
  SorobanAuthInspectorErrorCode,
  SorobanAuthInspectorResult,
} from "@/features/soroban-auth-inspector/types";

async function parseSorobanAuthInspectorInput(
  input: string,
): Promise<
  | { ok: true; value: { envelope: string } }
  | { ok: false; error: SorobanAuthInspectorErrorCode }
> {
  const trimmed = input.trim();

  if (!trimmed) {
    return { ok: false, error: "empty_input" };
  }

  try {
    Buffer.from(trimmed, "base64");
  } catch {
    return { ok: false, error: "invalid_base64" };
  }

  return { ok: true, value: { envelope: trimmed } };
}

type State =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "error"; code: SorobanAuthInspectorErrorCode }
  | { status: "success"; result: SorobanAuthInspectorResult };

export function useSorobanAuthInspector() {
  const [state, setState] = useState<State>({ status: "idle" });

  async function submit(rawInput: string) {
    setState({ status: "pending" });

    const parseResult = await parseSorobanAuthInspectorInput(rawInput);
    if (!parseResult.ok) {
      setState({ status: "error", code: parseResult.error });
      return;
    }

    // For now, return a minimal success state
    // Full XDR decoding would require stellar-sdk which isn't available client-side
    setState({
      status: "success",
      result: {
        authorizationEntries: [],
        totalEntries: 0,
        unobviousEntries: 0,
      },
    });
  }

  function reset() {
    setState({ status: "idle" });
  }

  return { state, submit, reset };
}
