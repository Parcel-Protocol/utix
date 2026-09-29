"use client";

import { useState } from "react";
import { Button } from "@/core/ui/Button";
import { Field } from "@/core/ui/Field";
import { Textarea } from "@/core/ui/Input";

interface SorobanAuthInspectorFormProps {
  onSubmit: (value: string) => void;
  pending?: boolean;
}

export function SorobanAuthInspectorForm({
  onSubmit,
  pending = false,
}: SorobanAuthInspectorFormProps) {
  const [input, setInput] = useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onSubmit(input);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4" noValidate>
      <Field label="Transaction Envelope (base64)" required>
        {({ inputId, describedBy, invalid, required }) => (
          <Textarea
            id={inputId}
            aria-describedby={describedBy}
            aria-invalid={invalid}
            required={required}
            placeholder="Paste a Soroban transaction envelope..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={pending}
            spellCheck={false}
            autoComplete="off"
            rows={6}
            className="font-mono text-sm"
          />
        )}
      </Field>

      <Button type="submit" disabled={pending || !input.trim()}>
        {pending ? "Inspecting..." : "Inspect Authorization"}
      </Button>
    </form>
  );
}
