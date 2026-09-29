"use client";

import { Card } from "@/core/ui/Card";
import { StatusMessage } from "@/core/ui/StatusMessage";
import { useExplorerLinks } from "@/features/explorer-links/hooks/useExplorerLinks";
import { errorCopy } from "@/features/explorer-links/copy";
import { ExplorerLinksForm } from "@/features/explorer-links/components/ExplorerLinksForm";
import { ExplorerLinksResult } from "@/features/explorer-links/components/ExplorerLinksResult";
import { ExplorerLinksEmptyState } from "@/features/explorer-links/components/ExplorerLinksEmptyState";

export function ExplorerLinksPanel() {
  const { state, submit } = useExplorerLinks();

  return (
    <div className="space-y-5">
      <Card>
        <ExplorerLinksForm onSubmit={submit} />
      </Card>

      {state.status === "error" ? (
        <StatusMessage
          type="error"
          title={errorCopy[state.code].title}
          description={errorCopy[state.code].description}
        />
      ) : null}

      {state.status === "success" ? <ExplorerLinksResult result={state.result} /> : null}

      {state.status === "idle" ? <ExplorerLinksEmptyState /> : null}
    </div>
  );
}
