"use client";

import { Card } from "@/core/ui/Card";
import { Badge } from "@/core/ui/Badge";
import type { SorobanContractSpec } from "@/features/soroban-spec-viewer/types";

interface SorobanSpecViewerResultProps {
  spec: SorobanContractSpec;
}

export function SorobanSpecViewerResult({ spec }: SorobanSpecViewerResultProps) {
  return (
    <div className="space-y-4">
      <Card className="space-y-3">
        <div>
          <p className="text-xs text-secondary">Contract Address</p>
          <p className="font-mono text-sm break-all">{spec.contractId}</p>
        </div>
        <div>
          <p className="text-xs text-secondary">WASM Hash</p>
          <p className="font-mono text-sm break-all">{spec.wasmHash}</p>
        </div>
      </Card>

      {spec.functions.length > 0 && (
        <Card className="space-y-3">
          <h3 className="font-semibold">Exported Functions ({spec.functions.length})</h3>
          <div className="space-y-2">
            {spec.functions.map((fn, i) => (
              <div key={i} className="p-2 rounded border border-secondary bg-surface">
                <div className="flex items-center justify-between mb-1">
                  <p className="font-mono text-sm font-semibold">{fn.name}</p>
                  <Badge tone="info">{fn.returns}</Badge>
                </div>
                {fn.doc && <p className="text-xs text-secondary mb-2">{fn.doc}</p>}
                {fn.args.length > 0 && (
                  <div className="text-xs space-y-1">
                    {fn.args.map((arg, j) => (
                      <div key={j} className="text-secondary">
                        <span className="font-mono">{arg.name}</span>: <span className="text-primary">{arg.type}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}

      {spec.types.length > 0 && (
        <Card className="space-y-3">
          <h3 className="font-semibold">Custom Types ({spec.types.length})</h3>
          <div className="space-y-2">
            {spec.types.map((type, i) => (
              <div key={i} className="p-2 rounded border border-secondary bg-surface">
                <p className="font-mono text-sm font-semibold mb-1">{type.name}</p>
                {type.doc && <p className="text-xs text-secondary mb-2">{type.doc}</p>}
                <div className="text-xs space-y-1">
                  {type.fields.map((field, j) => (
                    <div key={j} className="text-secondary">
                      <span className="font-mono">{field.name}</span>: <span className="text-primary">{field.type}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {spec.errors.length > 0 && (
        <Card className="space-y-3">
          <h3 className="font-semibold">Error Codes ({spec.errors.length})</h3>
          <div className="space-y-2">
            {spec.errors.map((error, i) => (
              <div key={i} className="p-2 rounded border border-secondary bg-surface">
                <div className="flex items-center justify-between">
                  <p className="font-mono text-sm font-semibold">{error.name}</p>
                  <Badge tone="warning">{error.code}</Badge>
                </div>
                {error.doc && <p className="text-xs text-secondary mt-1">{error.doc}</p>}
              </div>
            ))}
          </div>
        </Card>
      )}

      {spec.functions.length === 0 && spec.types.length === 0 && spec.errors.length === 0 && (
        <Card tone="muted" className="text-center py-6">
          <p className="text-sm text-secondary">No specification data available for this contract.</p>
        </Card>
      )}
    </div>
  );
}
