import { Card, CardHeader, CardTitle } from "@/core/ui/Card";
import { copy } from "@/features/scval-codec/copy";
import type { ScvalCodecResult as ScvalCodecResultValue } from "@/features/scval-codec/types";

export function ScvalCodecResult({ result }: { result: ScvalCodecResultValue }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{copy.resultTitle}</CardTitle>
      </CardHeader>
      <div className="space-y-3 text-sm">
        <p><strong>Direction:</strong> {result.direction}</p>
        <p><strong>Base64 ScVal</strong></p>
        <code className="block break-all rounded bg-slate-100 p-3">{result.base64}</code>
        <p><strong>Readable JSON</strong></p>
        <pre className="overflow-auto rounded bg-slate-100 p-3">{JSON.stringify(result.json, null, 2)}</pre>
      </div>
    </Card>
  );
}
