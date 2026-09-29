"use client";

import { AlertTriangle, CheckCircle } from "lucide-react";
import { Card } from "@/core/ui/Card";
import { Badge } from "@/core/ui/Badge";
import type { SorobanResourceFeeEstimate } from "@/features/soroban-fee-estimator/types";

interface SorobanFeeEstimatorResultProps {
  estimate: SorobanResourceFeeEstimate;
}

export function SorobanFeeEstimatorResult({ estimate }: SorobanFeeEstimatorResultProps) {
  const components = [
    estimate.components.cpuInstructions,
    estimate.components.memoryBytes,
    estimate.components.ledgerReadBytes,
    estimate.components.ledgerWriteBytes,
    estimate.components.ledgerRentBytes,
  ];

  const dominantComponent = components.reduce((prev, current) =>
    BigInt(current.totalFee) > BigInt(prev.totalFee) ? current : prev
  );

  return (
    <div className="space-y-4">
      <Card className="space-y-3">
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-sm text-secondary">Declared Fee</p>
            <p className="font-mono font-semibold">{estimate.declaredFee} stroops</p>
          </div>
          <div className="flex items-center justify-between">
            <p className="text-sm text-secondary">Estimated Total Fee</p>
            <p className="font-mono font-semibold">{estimate.estimatedFee} stroops</p>
          </div>
        </div>

        {estimate.status === "insufficient" && (
          <div className="flex items-start gap-2 p-2 rounded bg-warning/10 text-sm text-warning">
            <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
            <span>
              Declared fee is {estimate.difference} stroops short. Transaction may fail with
              tx_insufficient_fee.
            </span>
          </div>
        )}

        {estimate.status === "sufficient" && (
          <div className="flex items-start gap-2 p-2 rounded bg-success/10 text-sm text-success">
            <CheckCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
            <span>Declared fee covers estimated costs with {estimate.difference} stroops to spare.</span>
          </div>
        )}
      </Card>

      <Card className="space-y-3">
        <div>
          <h3 className="font-semibold mb-3">Fee Breakdown by Component</h3>
          <p className="text-xs text-secondary mb-3">
            Dominant component: <span className="font-semibold">{dominantComponent.name}</span>
          </p>
        </div>

        <div className="space-y-2">
          {components.map((comp, i) => (
            <div
              key={i}
              className={`p-2 rounded border ${
                comp === dominantComponent
                  ? "border-primary bg-primary/5"
                  : "border-secondary bg-surface"
              }`}
            >
              <div className="flex items-center justify-between mb-1">
                <p className="font-semibold text-sm">{comp.name}</p>
                <Badge tone={comp === dominantComponent ? "warning" : "muted"}>
                  {comp.totalFee} stroops
                </Badge>
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs text-secondary">
                <div>
                  <p>Count: <span className="font-mono">{comp.resourceCount}</span></p>
                </div>
                <div>
                  <p>Unit Price: <span className="font-mono">{comp.unitPrice}</span></p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
