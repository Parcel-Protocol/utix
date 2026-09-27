"use client";

import { Card, CardHeader, CardTitle } from "@/core/ui/Card";
import { Badge } from "@/core/ui/Badge";
import { CopyableValue } from "@/core/ui/CopyableValue";
import { copy } from "@/features/claimable-predicate-builder/copy";
import type { ClaimablePredicateBuilderResult as ClaimablePredicateBuilderResultValue } from "@/features/claimable-predicate-builder/types";

export function ClaimablePredicateBuilderResult({
  result
}: {
  result: ClaimablePredicateBuilderResultValue;
}) {
  const { plainLanguage, base64Xdr, analysis } = result;

  return (
    <Card className="space-y-5">
      <CardHeader className="flex flex-row items-center justify-between gap-4">
        <CardTitle>{copy.resultTitle}</CardTitle>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={analysis.isSatisfiable ? "success" : "danger"}>
            {analysis.isSatisfiable ? copy.satisfiable : copy.unsatisfiable}
          </Badge>
          <Badge tone="info">
            {copy.depthNotice}: {analysis.depth}
          </Badge>
          <Badge tone="muted">
            {copy.nodeCountNotice}: {analysis.nodeCount}
          </Badge>
        </div>
      </CardHeader>

      {analysis.warning ? (
        <div
          role="alert"
          className="p-3 text-sm rounded-md bg-[#FFF5F5] dark:bg-[#742A2A]/30 border border-[#FEB2B2] dark:border-[#E53E3E] text-[#C53030] dark:text-[#FEB2B2]"
        >
          {analysis.warning}
        </div>
      ) : null}

      <div className="space-y-2">
        <span className="block text-xs font-semibold uppercase tracking-wider text-[#4A5568] dark:text-[#A0AEC0]">
          {copy.plainLanguageTitle}
        </span>
        <div className="p-4 rounded-md border border-[#E2E8F0] dark:border-[#2D3748] bg-[#F7FAFC] dark:bg-[#1A202C] text-sm leading-relaxed text-[#1A202C] dark:text-white font-medium">
          {plainLanguage}
        </div>
      </div>

      <div className="space-y-2">
        <span className="block text-xs font-semibold uppercase tracking-wider text-[#4A5568] dark:text-[#A0AEC0]">
          {copy.xdrTitle}
        </span>
        <CopyableValue label={copy.xdrTitle} value={base64Xdr} full />
      </div>
    </Card>
  );
}
