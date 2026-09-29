"use client";

import { AlertCircle } from "lucide-react";
import { Card } from "@/core/ui/Card";

export function ExplorerLinksEmptyState() {
  return (
    <Card tone="muted" className="flex items-start gap-3 p-4">
      <AlertCircle className="w-5 h-5 mt-0.5 flex-shrink-0" />
      <div className="space-y-2">
        <h3 className="font-semibold">Generate Explorer Links</h3>
        <p className="text-sm text-secondary">
          Paste any Stellar identifier to get direct links on all major explorers 
          for the selected network.
        </p>
      </div>
    </Card>
  );
}
