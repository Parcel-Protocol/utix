import { Card, CardHeader, CardTitle } from "@/core/ui/Card";
import { copy } from "@/features/keypair-generator/copy";
import type { KeypairGeneratorResult as KeypairGeneratorResultValue } from "@/features/keypair-generator/types";

export function KeypairGeneratorResult({ result }: { result: KeypairGeneratorResultValue }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{copy.resultTitle}</CardTitle>
      </CardHeader>
      <div className="space-y-4 text-sm">
        <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-amber-900">
          Testnet only. Treat the secret key like a password: never share it, commit it, or use it on mainnet.
        </p>
        <p><strong>Public key</strong><br /><code className="break-all">{result.publicKey}</code></p>
        <p><strong>Secret key</strong><br /><code className="break-all">{result.secretKey}</code></p>
      </div>
    </Card>
  );
}
