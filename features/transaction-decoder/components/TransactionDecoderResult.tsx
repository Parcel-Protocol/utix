import { Badge } from "@/core/ui/Badge";
import { Card, CardHeader, CardTitle } from "@/core/ui/Card";
import { DataList } from "@/core/ui/DataList";
import { copy } from "@/features/transaction-decoder/copy";
import { OperationCard } from "@/features/transaction-decoder/components/OperationCard";
import type { DecodedTransactionResult } from "@/features/transaction-decoder/types";

export function TransactionDecoderResult({ result }: { result: DecodedTransactionResult }) {
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>{copy.resultTitle}</CardTitle>
            <Badge variant="info">{copy.staticBadge}</Badge>
          </div>
        </CardHeader>
        <DataList
          items={[
            { label: "Source Account", value: result.sourceAccount },
            { label: "Sequence", value: result.sequence },
            { label: "Fee (stroops)", value: result.fee },
            { label: "Signatures", value: String(result.signatureCount) },
            { label: "Operation Count", value: String(result.operationCount) },
            { label: "Network", value: result.network }
          ]}
        />
      </Card>

      <div className="space-y-3">
        <h3 className="text-sm font-semibold">{copy.operationsTitle}</h3>
        {result.operations.map((op) => (
          <OperationCard key={op.index} op={op} />
        ))}
      </div>
    </div>
  );
}
