"use client";

import { AlertTriangle, ShieldAlert } from "lucide-react";
import { Card } from "@/core/ui/Card";
import { Badge } from "@/core/ui/Badge";
import type {
  SorobanAuthInspectorResult,
  SorobanAuthorizationTreeNode,
} from "@/features/soroban-auth-inspector/types";

interface SorobanAuthInspectorResultProps {
  result: SorobanAuthInspectorResult;
}

function CredentialsBadge({
  credentials,
}: {
  credentials: SorobanAuthorizationTreeNode["credentials"];
}) {
  if (credentials.type === "source_account") {
    return <Badge tone="success">Source Account</Badge>;
  }

  return <Badge tone="warning">Address Signer</Badge>;
}

function AuthorizationEntryNode({
  entry,
  index,
}: {
  entry: SorobanAuthorizationTreeNode;
  index: number;
}) {
  const { credentials, rootInvocation, impliesUnobviousSubInvocation } = entry;

  return (
    <div key={index} className="space-y-3 p-4 rounded-lg border border-secondary bg-surface">
      <div className="flex items-center justify-between">
        <h4 className="font-semibold">Authorization Entry {index + 1}</h4>
        <CredentialsBadge credentials={credentials} />
      </div>

      {impliesUnobviousSubInvocation && (
        <div className="flex items-start gap-2 p-2 rounded bg-warning/10 text-sm text-warning">
          <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <span>This entry authorizes sub-invocations not explicitly visible in the top-level call.</span>
        </div>
      )}

      <div className="space-y-2">
        <div>
          <p className="text-xs font-mono text-secondary">Contract</p>
          <p className="font-mono text-sm break-all">{rootInvocation.contractAddress.slice(0, 32)}...</p>
        </div>

        <div>
          <p className="text-xs font-mono text-secondary">Function</p>
          <p className="font-mono text-sm">{rootInvocation.functionName}</p>
        </div>

        {rootInvocation.args.length > 0 && (
          <div>
            <p className="text-xs font-mono text-secondary">Arguments ({rootInvocation.args.length})</p>
            <ul className="space-y-1 mt-1">
              {rootInvocation.args.map((arg, i) => (
                <li key={i} className="text-sm font-mono text-secondary">
                  [{i}] {arg.type}: {arg.value}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {credentials.type === "address" && (
        <div className="space-y-2 pt-2 border-t border-secondary">
          <div>
            <p className="text-xs font-mono text-secondary">Signer Address</p>
            <p className="font-mono text-sm break-all">{credentials.address.slice(0, 32)}...</p>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <p className="text-xs font-mono text-secondary">Nonce</p>
              <p className="font-mono text-sm">{credentials.nonce}</p>
            </div>
            <div>
              <p className="text-xs font-mono text-secondary">Expiry Ledger</p>
              <p className="font-mono text-sm">{credentials.expiryLedger}</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function SorobanAuthInspectorResult({
  result,
}: SorobanAuthInspectorResultProps) {
  return (
    <div className="space-y-4">
      <Card className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold">Authorization Summary</h3>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <p className="text-xs text-secondary">Total Entries</p>
            <p className="text-2xl font-bold">{result.totalEntries}</p>
          </div>
          <div>
            <p className="text-xs text-secondary">Unobvious Sub-Invocations</p>
            <p className="text-2xl font-bold text-warning">{result.unobviousEntries}</p>
          </div>
        </div>

        {result.unobviousEntries > 0 && (
          <div className="flex items-start gap-2 p-2 rounded bg-warning/10 text-sm text-warning">
            <ShieldAlert className="w-4 h-4 mt-0.5 flex-shrink-0" />
            <span>
              {result.unobviousEntries} authorization {result.unobviousEntries === 1 ? "entry" : "entries"}{" "}
              authorize hidden sub-calls. Review carefully before signing.
            </span>
          </div>
        )}
      </Card>

      <div className="space-y-3">
        <h3 className="font-semibold">Authorization Tree</h3>
        {result.authorizationEntries.map((entry, index) => (
          <AuthorizationEntryNode key={index} entry={entry} index={index} />
        ))}
      </div>
    </div>
  );
}
