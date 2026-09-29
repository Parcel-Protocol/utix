"use client";

import { AlertCircle } from "lucide-react";
import { Card } from "@/core/ui/Card";

export function SorobanAuthInspectorEmptyState() {
  return (
    <Card tone="muted" className="flex items-start gap-3 p-4">
      <AlertCircle className="w-5 h-5 mt-0.5 flex-shrink-0" />
      <div className="space-y-2">
        <h3 className="font-semibold">Decode Soroban Authorization Entries</h3>
        <p className="text-sm text-secondary">
          Paste a transaction envelope to see which sub-invocations each authorization entry permits. 
          This reveals what a signer actually authorizes, including any hidden contract calls.
        </p>
      </div>
    </Card>
  );
}
