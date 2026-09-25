import { Sparkles } from "lucide-react";
import { Card, CardHeader, CardTitle } from "@/core/ui/Card";
import { CopyableValue } from "@/core/ui/CopyableValue";
import { DataList } from "@/core/ui/DataList";
import { EmptyState } from "@/core/ui/EmptyState";
import { Badge } from "@/core/ui/Badge";
import { copy } from "@/features/claimable-balances/copy";
import {
  formatAmount,
  formatBalanceHeading,
  formatClaimantStatus,
  formatTimestamp
} from "@/features/claimable-balances/lib/format";
import type { HorizonPredicate } from "@/features/claimable-balances/lib/predicate";
import type { ClaimableBalancesResult as ClaimableBalancesResultValue } from "@/features/claimable-balances/types";

function PredicateTree({ predicate, depth = 0 }: { predicate: HorizonPredicate; depth?: number }) {
  const entries = Object.entries(predicate).filter(([, value]) => value !== undefined);

  return (
    <ul className="space-y-1 border-l border-[#c7d6e8] pl-3 text-xs text-[#4e5c73]">
      {entries.map(([key, value]) => (
        <li key={`${key}-${depth}`}>
          <span className="font-mono font-semibold text-[#172033]">{key}</span>
          {Array.isArray(value) ? (
            <ul className="mt-1 space-y-1 pl-3">
              {value.map((child, index) => (
                <li key={`${key}-${index}`}>
                  <PredicateTree predicate={child} depth={depth + 1} />
                </li>
              ))}
            </ul>
          ) : typeof value === "object" && value !== null ? (
            <PredicateTree predicate={value as HorizonPredicate} depth={depth + 1} />
          ) : (
            <span className="ml-2 break-words">{String(value)}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

export function ClaimableBalancesResult({ result }: { result: ClaimableBalancesResultValue }) {
  if (!result.balances.length) {
    return (
      <EmptyState
        icon={Sparkles}
        title={copy.noBalancesTitle}
        description={copy.noBalancesDescription}
      />
    );
  }

  const title =
    result.mode === "balance" ? copy.resultTitleSingle : copy.resultTitle;

  return (
    <div className="space-y-4">
      {result.mode === "account" ? (
        <p className="text-sm font-semibold text-[#4e5c73]">{copy.listCount(result.balances.length)}</p>
      ) : null}

      {result.balances.map((balance) => (
        <Card key={balance.id}>
          <CardHeader>
            <CardTitle>{title}</CardTitle>
          </CardHeader>

          <div className="space-y-4">
            <p className="text-lg font-extrabold text-[#172033]">{formatBalanceHeading(balance)}</p>

            <DataList
              items={[
                {
                  label: "Balance ID",
                  value: <CopyableValue label="claimable balance ID" value={balance.id} visible={8} />
                },
                {
                  label: copy.fundedAtLabel,
                  value: formatTimestamp(balance.fundedAt)
                },
                {
                  label: copy.ledgerLabel,
                  value: String(balance.lastModifiedLedger),
                  mono: true
                },
                ...(balance.sponsor
                  ? [
                      {
                        label: copy.sponsorLabel,
                        value: <CopyableValue label="sponsor" value={balance.sponsor} />
                      }
                    ]
                  : [])
              ]}
            />

            <div>
              <h3 className="mb-3 text-sm font-extrabold uppercase tracking-wide text-[#4e5c73]">
                {copy.claimantsTitle}
              </h3>
              <ol className="space-y-3">
                {balance.claimants.map((claimant) => (
                  <li
                    key={claimant.destination}
                    className="rounded-md border border-[#e3ebf5] bg-white/60 px-3 py-3 text-sm"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <CopyableValue label="claimant" value={claimant.destination} visible={4} />
                      <Badge tone={claimant.claimableNow ? "success" : "muted"}>
                        {formatClaimantStatus(claimant.claimableNow)}
                      </Badge>
                    </div>
                    <p className="mt-2 text-[#172033]">{claimant.predicateText}</p>
                    <details className="mt-3">
                      <summary className="cursor-pointer text-xs font-bold text-[#4e5c73]">
                        Predicate tree
                      </summary>
                      <div className="mt-2" role="tree" aria-label="Claim predicate tree">
                        <PredicateTree predicate={claimant.predicate} />
                      </div>
                    </details>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}
