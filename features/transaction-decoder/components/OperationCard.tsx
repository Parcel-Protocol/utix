import { Badge } from "@/core/ui/Badge";
import type { DecodedOperation } from "@/features/transaction-decoder/types";

export function OperationCard({ op }: { op: DecodedOperation }) {
  return (
    <div className="rounded-lg border p-4 space-y-2">
      <div className="flex items-center justify-between">
        <span className="font-semibold text-sm">Op #{op.index + 1}: {op.type}</span>
        <div className="flex gap-1">
          {op.isCancelOffer ? <Badge variant="warning">Cancel Offer</Badge> : null}
          {op.isSponsorship ? <Badge variant="info">Sponsorship</Badge> : null}
          {op.isMuxedDestination ? <Badge variant="neutral">Muxed Destination</Badge> : null}
        </div>
      </div>
      {op.sourceAccount ? (
        <div className="text-xs text-muted-foreground">
          Source: <code className="text-xs">{op.sourceAccount}</code>
        </div>
      ) : null}
      <div className="grid grid-cols-2 gap-2 text-xs">
        {Object.entries(op.details).map(([key, value]) => (
          <div key={key}>
            <span className="text-muted-foreground">{key}: </span>
            <span className="font-mono">{String(value)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
