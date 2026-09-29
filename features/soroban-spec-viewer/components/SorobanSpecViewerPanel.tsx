"use client";

import { Card } from "@/core/ui/Card";
import { StatusMessage } from "@/core/ui/StatusMessage";
import { useSorobanSpecViewer } from "@/features/soroban-spec-viewer/hooks/useSorobanSpecViewer";
import { errorCopy } from "@/features/soroban-spec-viewer/copy";
import { SorobanSpecViewerForm } from "@/features/soroban-spec-viewer/components/SorobanSpecViewerForm";
import { SorobanSpecViewerResult } from "@/features/soroban-spec-viewer/components/SorobanSpecViewerResult";
import { SorobanSpecViewerEmptyState } from "@/features/soroban-spec-viewer/components/SorobanSpecViewerEmptyState";

export function SorobanSpecViewerPanel() {
  const { state, submit } = useSorobanSpecViewer();

  return (
    <div className="space-y-5">
      <Card>
        <SorobanSpecViewerForm onSubmit={submit} pending={state.status === "pending"} />
      </Card>

      {state.status === "error" ? (
        <StatusMessage
          type="error"
          title={errorCopy[state.code].title}
          description={errorCopy[state.code].description}
        />
      ) : null}

      {state.status === "success" ? <SorobanSpecViewerResult spec={state.spec} /> : null}

      {state.status === "idle" ? <SorobanSpecViewerEmptyState /> : null}
    </div>
  );
}
