"use client";

import { ExternalLink } from "lucide-react";
import { Card } from "@/core/ui/Card";
import { Badge } from "@/core/ui/Badge";
import type { ExplorerLinksResult, IdentifierType } from "@/features/explorer-links/types";

interface ExplorerLinksResultProps {
  result: ExplorerLinksResult;
}

function getIdentifierTypeBadge(type: IdentifierType) {
  const colors: Record<IdentifierType, "info" | "success" | "warning" | "muted"> = {
    account: "info",
    transaction: "success",
    ledger: "warning",
    asset: "info",
    contract: "success",
    unknown: "muted",
  };
  return colors[type];
}

export function ExplorerLinksResult({ result }: ExplorerLinksResultProps) {
  return (
    <div className="space-y-4">
      <Card className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs text-secondary">Identifier Type</p>
            <p className="font-mono text-sm break-all">{result.identifier}</p>
          </div>
          <Badge tone={getIdentifierTypeBadge(result.type)}>{result.type}</Badge>
        </div>
      </Card>

      <div className="space-y-2">
        {result.links.map((link, i) => (
          <a
            key={i}
            href={link.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-between p-3 rounded border border-secondary hover:bg-surface hover:border-primary transition-colors"
          >
            <div>
              <p className="font-semibold text-sm">{link.name}</p>
              <p className="text-xs text-secondary font-mono">{link.explorer}</p>
            </div>
            <ExternalLink className="w-4 h-4 text-secondary flex-shrink-0" />
          </a>
        ))}
      </div>
    </div>
  );
}
