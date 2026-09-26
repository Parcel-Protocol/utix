"use client";

import { useState, type FormEvent } from "react";
import { Button } from "@/core/ui/Button";
import { Field } from "@/core/ui/Field";
import { copy } from "@/features/transaction-decoder/copy";

export function TransactionDecoderForm({
  onSubmit,
  pending
}: {
  onSubmit: (value: string) => void;
  pending: boolean;
}) {
  const [xdr, setXdr] = useState("");

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit(xdr);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <Field label={copy.formLabel} hint={copy.formHint}>
        {({ inputId, describedBy, invalid }) => (
          <textarea
            id={inputId}
            aria-describedby={describedBy}
            aria-invalid={invalid}
            value={xdr}
            onChange={(event) => setXdr(event.target.value)}
            className="w-full h-32 rounded-md border p-2 text-xs font-mono"
            placeholder="AAAAAgAAA..."
            spellCheck={false}
          />
        )}
      </Field>
      <Button type="submit" disabled={pending} aria-busy={pending}>
        {pending ? "Decoding..." : copy.submit}
      </Button>
    </form>
  );
}
