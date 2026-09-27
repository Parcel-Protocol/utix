"use client";

import { Card, CardHeader, CardTitle } from "@/core/ui/Card";
import { Badge } from "@/core/ui/Badge";
import { CopyableValue } from "@/core/ui/CopyableValue";
import { copy } from "@/features/simulation-explainer/copy";
import type { SimulationExplainerResult as SimulationExplainerResultValue } from "@/features/simulation-explainer/types";

export function SimulationExplainerResult({
  result
}: {
  result: SimulationExplainerResultValue;
}) {
  const { status, latestLedger, cost, fees, footprint, auth, events, errorExplanation, rawResponseJson } = result;

  const statusTone = status === "success" ? "success" : status === "restore_required" ? "warning" : "danger";
  const statusLabel =
    status === "success" ? copy.statusSuccess : status === "restore_required" ? copy.statusRestore : copy.statusFailed;

  return (
    <div className="space-y-5">
      <Card className="space-y-4">
        <CardHeader className="flex flex-row items-center justify-between gap-4">
          <CardTitle>{copy.resultTitle}</CardTitle>
          <Badge tone={statusTone}>{statusLabel}</Badge>
        </CardHeader>

        {errorExplanation ? (
          <div
            role="alert"
            className="p-3 text-sm rounded-md bg-[#FFF5F5] dark:bg-[#742A2A]/30 border border-[#FEB2B2] dark:border-[#E53E3E] text-[#C53030] dark:text-[#FEB2B2]"
          >
            <span className="font-semibold block mb-1">{copy.errorTitle}</span>
            {errorExplanation}
          </div>
        ) : null}

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="p-3 border rounded-md border-[#E2E8F0] dark:border-[#2D3748]">
            <span className="text-xs font-semibold text-[#718096] uppercase tracking-wider block">
              {copy.cpuUsage}
            </span>
            <span className="text-lg font-bold text-[#1A202C] dark:text-white mt-1 block">
              {cost.cpuInsns}
            </span>
            <span className="text-xs text-[#718096]">{cost.cpuPercentage}% of max per-tx limit</span>
          </div>

          <div className="p-3 border rounded-md border-[#E2E8F0] dark:border-[#2D3748]">
            <span className="text-xs font-semibold text-[#718096] uppercase tracking-wider block">
              {copy.memUsage}
            </span>
            <span className="text-lg font-bold text-[#1A202C] dark:text-white mt-1 block">
              {cost.memBytes}
            </span>
            <span className="text-xs text-[#718096]">{cost.memPercentage}% of max per-tx limit</span>
          </div>

          <div className="p-3 border rounded-md border-[#E2E8F0] dark:border-[#2D3748]">
            <span className="text-xs font-semibold text-[#718096] uppercase tracking-wider block">
              {copy.minResourceFee}
            </span>
            <span className="text-lg font-bold text-[#1A202C] dark:text-white mt-1 block">
              {fees.minResourceFeeXlm}
            </span>
            <span className="text-xs text-[#718096]">{fees.minResourceFeeStroops}</span>
          </div>
        </div>

        <div className="p-4 border rounded-md border-[#E2E8F0] dark:border-[#2D3748] space-y-2">
          <span className="text-sm font-semibold text-[#1A202C] dark:text-white block">
            {copy.footprintTitle}
          </span>
          <div className="flex flex-wrap gap-4 text-sm text-[#4A5568] dark:text-[#A0AEC0]">
            <div>
              {copy.readOnlyKeys}: <span className="font-semibold text-[#1A202C] dark:text-white">{footprint.readOnlyCount}</span>
            </div>
            <div>
              {copy.readWriteKeys}: <span className="font-semibold text-[#1A202C] dark:text-white">{footprint.readWriteCount}</span>
            </div>
            <div>
              Latest Ledger: <span className="font-semibold text-[#1A202C] dark:text-white">{latestLedger}</span>
            </div>
          </div>
          {footprint.restoreRequired ? (
            <div className="mt-2 text-xs text-[#DD6B20] font-medium">
              State restoration is required before submitting. Estimated restore fee: {footprint.restoreFeeStroops ?? "unknown"}.
            </div>
          ) : null}
        </div>

        {auth.length > 0 ? (
          <div className="space-y-2">
            <span className="text-sm font-semibold text-[#1A202C] dark:text-white block">
              {copy.authTitle} ({auth.length})
            </span>
            <div className="space-y-1">
              {auth.map((a, idx) => (
                <div key={idx} className="text-xs p-2 rounded bg-[#F7FAFC] dark:bg-[#1A202C] font-mono">
                  {a.address ?? "SorobanAddressCredentials"} ({a.invocationCount} invocation)
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {events.length > 0 ? (
          <div className="space-y-2">
            <span className="text-sm font-semibold text-[#1A202C] dark:text-white block">
              {copy.eventsTitle} ({events.length})
            </span>
            <div className="space-y-1">
              {events.map((ev, idx) => (
                <div key={idx} className="text-xs p-2 rounded bg-[#F7FAFC] dark:bg-[#1A202C] flex justify-between">
                  <span className="font-semibold">{ev.type}</span>
                  <span className="text-[#718096]">{ev.contractId ? `Contract: ${ev.contractId.slice(0, 8)}...` : ""}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <div className="space-y-2 pt-2">
          <span className="text-xs font-semibold text-[#718096] uppercase tracking-wider block">
            {copy.rawJsonTitle}
          </span>
          <CopyableValue label={copy.rawJsonTitle} value={rawResponseJson} />
        </div>
      </Card>
    </div>
  );
}
