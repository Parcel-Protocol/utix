"use client";

import { Card } from "@/core/ui/Card";
import { StatusMessage } from "@/core/ui/StatusMessage";
import { useKeypairGenerator } from "@/features/keypair-generator/hooks/useKeypairGenerator";
import { errorCopy } from "@/features/keypair-generator/copy";
import { KeypairGeneratorForm } from "@/features/keypair-generator/components/KeypairGeneratorForm";
import { KeypairGeneratorResult } from "@/features/keypair-generator/components/KeypairGeneratorResult";
import { KeypairGeneratorEmptyState } from "@/features/keypair-generator/components/KeypairGeneratorEmptyState";

export function KeypairGeneratorPanel() {
  const { state, submit } = useKeypairGenerator();

  return (
    <div className="space-y-5">
      <Card>
        <KeypairGeneratorForm onSubmit={submit} pending={state.status === "loading"} />
      </Card>

      {state.status === "error" ? (
        <StatusMessage
          type="error"
          title={errorCopy[state.code].title}
          description={errorCopy[state.code].description}
        />
      ) : null}

      {state.status === "success" ? <KeypairGeneratorResult result={state.result} /> : null}

      {state.status === "idle" ? <KeypairGeneratorEmptyState /> : null}
    </div>
  );
}
