"use client";

import { AlertCircle } from "lucide-react";
import { Card } from "@/core/ui/Card";

export function SorobanSpecViewerEmptyState() {
  return (
    <Card tone="muted" className="flex items-start gap-3 p-4">
      <AlertCircle className="w-5 h-5 mt-0.5 flex-shrink-0" />
      <div className="space-y-2">
        <h3 className="font-semibold">View Contract Interface</h3>
        <p className="text-sm text-secondary">
          Enter a Soroban contract address to see its exported functions, argument types, 
          custom types, and error codes directly from the chain.
        </p>
      </div>
    </Card>
  );
}
