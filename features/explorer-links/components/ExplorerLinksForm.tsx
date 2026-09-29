"use client";

import { useState } from "react";
import { Button } from "@/core/ui/Button";
import { Field } from "@/core/ui/Field";
import { Input } from "@/core/ui/Input";

interface ExplorerLinksFormProps {
  onSubmit: (identifier: string) => void;
}

export function ExplorerLinksForm({ onSubmit }: ExplorerLinksFormProps) {
  const [input, setInput] = useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onSubmit(input);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4" noValidate>
      <Field
        label="Stellar Identifier"
        hint="Account (G...), transaction, ledger, asset (code:issuer), or contract (C...)"
        required
      >
        {({ inputId, describedBy, invalid, required }) => (
          <Input
            id={inputId}
            aria-describedby={describedBy}
            aria-invalid={invalid}
            required={required}
            placeholder="GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTCQXE3ES3JDTC2I23NRM7UVP"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            className="font-mono text-sm"
            autoComplete="off"
          />
        )}
      </Field>

      <Button type="submit" disabled={!input.trim()}>
        Generate Links
      </Button>
    </form>
  );
}
