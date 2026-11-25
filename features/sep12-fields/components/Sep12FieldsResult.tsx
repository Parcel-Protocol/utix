import { Card, CardHeader, CardTitle } from "@/core/ui/Card";
import { copy } from "@/features/sep12-fields/copy";
import type { Sep12FieldsResult as Sep12FieldsResultValue } from "@/features/sep12-fields/types";

export function Sep12FieldsResult({ result }: { result: Sep12FieldsResultValue }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{copy.resultTitle}</CardTitle>
      </CardHeader>
      <div className="space-y-3">
        {result.fields.map((field) => (
          <article key={field.name} className="rounded border border-slate-200 p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2"><strong>{field.name}</strong><span className="text-slate-500">{field.type}</span>{field.required ? <span className="text-amber-700">required</span> : null}</div>
            <p className="mt-1 text-slate-600">{field.description}</p>
          </article>
        ))}
      </div>
    </Card>
  );
}
