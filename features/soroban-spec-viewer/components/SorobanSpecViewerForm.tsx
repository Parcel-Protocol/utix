"use client";

import { useState } from "react";
import { Button } from "@/core/ui/Button";
import { Field } from "@/core/ui/Field";
import { Input } from "@/core/ui/Input";

interface SorobanSpecViewerFormProps {
  onSubmit: (address: string) => void;
  pending?: boolean;
}

export function SorobanSpecViewerForm({
  onSubmit,
  pending = false,
}: SorobanSpecViewerFormProps) {
  const [input, setInput] = useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onSubmit(input);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4" noValidate>
      <Field
        label="Contract Address"
        hint="C... (56 character Soroban contract address)"
        required
      >
        {({ inputId, describedBy, invalid, required }) => (
          <Input
            id={inputId}
            aria-describedby={describedBy}
            aria-invalid={invalid}
            required={required}
            placeholder="C..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={pending}
            className="font-mono text-sm"
            autoComplete="off"
          />
        )}
      </Field>

      <Button type="submit" disabled={pending || !input.trim()}>
        {pending ? "Loading spec..." : "View Contract Spec"}
      </Button>
    </form>
  );
}
