import { Badge } from "@/core/ui/Badge";
import { AccessibleTree, type AccessibleTreeNode } from "@/core/ui/AccessibleTree";
import type { DecodedOperation } from "@/features/transaction-decoder/types";

export function OperationCard({ op }: { op: DecodedOperation }) {
  return (
    <div className="rounded-lg border p-4 space-y-2">
      <div className="flex items-center justify-between">
        <span className="font-semibold text-sm">Op #{op.index + 1}: {op.type}</span>
        <div className="flex gap-1">
          {op.isCancelOffer ? <Badge tone="warning">Cancel Offer</Badge> : null}
          {op.isSponsorship ? <Badge tone="info">Sponsorship</Badge> : null}
          {op.isMuxedDestination ? <Badge tone="muted">Muxed Destination</Badge> : null}
        </div>
      </div>
      {op.sourceAccount ? (
        <div className="text-xs text-muted-foreground">
          Source: <code className="text-xs">{op.sourceAccount}</code>
        </div>
      ) : null}
      <AccessibleTree label={`Operation ${op.index + 1} details`} nodes={toTreeNodes(op.details, `operation-${op.index}`)} />
    </div>
  );
}

function toTreeNodes(value: unknown, prefix: string): AccessibleTreeNode[] {
  if (value === null || typeof value !== "object") {
    return [{ id: prefix, label: "value", value: String(value) }];
  }
  return Object.entries(value).map(([label, child], index) => {
    const id = `${prefix}-${index}`;
    return child !== null && typeof child === "object"
      ? { id, label, children: toTreeNodes(child, id) }
      : { id, label, value: String(child) };
  });
}
