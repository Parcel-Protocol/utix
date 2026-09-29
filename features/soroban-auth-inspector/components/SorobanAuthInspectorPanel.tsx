"use client";

import { Card } from "@/core/ui/Card";
import { StatusMessage } from "@/core/ui/StatusMessage";
import { useSorobanAuthInspector } from "@/features/soroban-auth-inspector/hooks/useSorobanAuthInspector";
import { errorCopy } from "@/features/soroban-auth-inspector/copy";
import { SorobanAuthInspectorForm } from "@/features/soroban-auth-inspector/components/SorobanAuthInspectorForm";
import { SorobanAuthInspectorResult } from "@/features/soroban-auth-inspector/components/SorobanAuthInspectorResult";
import { SorobanAuthInspectorEmptyState } from "@/features/soroban-auth-inspector/components/SorobanAuthInspectorEmptyState";

export function SorobanAuthInspectorPanel() {
  const { state, submit } = useSorobanAuthInspector();

  return (
    <div className="space-y-5">
      <Card>
        <SorobanAuthInspectorForm onSubmit={submit} pending={state.status === "pending"} />
      </Card>

      {state.status === "error" ? (
        <StatusMessage
          type="error"
          title={errorCopy[state.code].title}
          description={errorCopy[state.code].description}
        />
      ) : null}

      {state.status === "success" ? <SorobanAuthInspectorResult result={state.result} /> : null}

      {state.status === "idle" ? <SorobanAuthInspectorEmptyState /> : null}
    </div>
  );
}
