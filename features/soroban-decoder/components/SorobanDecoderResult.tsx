import { Badge } from "@/core/ui/Badge";
import { Card, CardHeader, CardTitle } from "@/core/ui/Card";
import { DataList } from "@/core/ui/DataList";
import { copy } from "@/features/soroban-decoder/copy";
import type { ScValNode, SorobanDecoderResult } from "@/features/soroban-decoder/types";

function TreeNode({ node }: { node: ScValNode }) {
  return (
    <div className="pl-4 border-l my-1">
      <div className="flex items-center gap-2 text-xs">
        <Badge variant="neutral">{node.type}</Badge>
        <span className="font-mono">{node.value}</span>
      </div>
      {node.children ? (
        <div className="space-y-1 mt-1">
          {node.children.map((child, i) => (
            <TreeNode key={i} node={child} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function SorobanDecoderResult({ result }: { result: SorobanDecoderResult }) {
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>{copy.resultTitle}</CardTitle>
            <Badge variant={result.specAvailable ? "success" : "warning"}>
              {result.specAvailable ? copy.specAvailable : copy.specFallback}
            </Badge>
          </div>
        </CardHeader>
        <DataList
          items={[
            { label: "Contract ID", value: result.contractId ?? "N/A" },
            { label: "Function Name", value: result.functionName ?? "N/A" },
            { label: "Network", value: result.network },
            { label: "Execution Mode", value: "Read-Only (No Signature Required)" }
          ]}
        />
      </Card>

      {result.simulation ? (
        <Card>
          <CardHeader>
            <CardTitle>{copy.simulationTitle}</CardTitle>
          </CardHeader>
          <DataList
            items={[
              { label: "Resource Fee (stroops)", value: result.simulation.minResourceFee },
              { label: "CPU Instructions", value: result.simulation.cpuInstructions },
              { label: "Memory (bytes)", value: result.simulation.memoryBytes },
              { label: "Auth Entries", value: String(result.simulation.authEntriesCount) }
            ]}
          />
        </Card>
      ) : null}

      <div className="space-y-2">
        <h3 className="text-sm font-semibold">{copy.argsTitle}</h3>
        <div className="rounded-lg border p-4 bg-muted/20 space-y-2">
          {result.argsTree.map((node, i) => (
            <TreeNode key={i} node={node} />
          ))}
        </div>
      </div>
    </div>
  );
}
