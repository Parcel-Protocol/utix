"use client";

import { StatusMessage } from "@/core/ui/StatusMessage";
import { SorobanDecoderEmptyState } from "@/features/soroban-decoder/components/SorobanDecoderEmptyState";
import { SorobanDecoderForm } from "@/features/soroban-decoder/components/SorobanDecoderForm";
import { SorobanDecoderResult } from "@/features/soroban-decoder/components/SorobanDecoderResult";
import { errorCopy } from "@/features/soroban-decoder/copy";
import { useSorobanDecoder } from "@/features/soroban-decoder/hooks/useSorobanDecoder";
import { mapSorobanDecoderError } from "@/features/soroban-decoder/lib/sorobanDecoder.errors";

export function SorobanDecoderPanel() {
  const { state, submit } = useSorobanDecoder();

  return (
    <div className="space-y-6">
      <SorobanDecoderForm onSubmit={submit} pending={state.status === "pending"} />

      {state.status === "error" ? (
        <StatusMessage
          type="error"
          title={errorCopy[state.code].title}
          description={mapSorobanDecoderError(state.code)}
        />
      ) : null}

      {state.status === "success" ? <SorobanDecoderResult result={state.result} /> : null}

      {state.status === "idle" ? <SorobanDecoderEmptyState /> : null}
    </div>
  );
}
