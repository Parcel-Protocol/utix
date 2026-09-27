"use client";

import { useState, type FormEvent } from "react";
import { Button } from "@/core/ui/Button";
import { Field } from "@/core/ui/Field";
import { copy } from "@/features/simulation-explainer/copy";

export function SimulationExplainerForm({
  onSubmit,
  pending
}: {
  onSubmit: (value: string) => void;
  pending: boolean;
}) {
  const [value, setValue] = useState("");

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit(value);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <Field label={copy.formLabel} hint={copy.formHint}>
        {({ inputId, describedBy, invalid }) => (
          <textarea
            id={inputId}
            aria-describedby={describedBy}
            aria-invalid={invalid}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            rows={4}
            className="w-full px-3 py-2 text-xs font-mono border rounded-md border-[#CBD5E0] dark:border-[#4A5568] bg-white dark:bg-[#1A202C] text-[#1A202C] dark:text-white focus:outline-none focus:ring-2 focus:ring-[#3182CE]"
            placeholder='AAAAAgAAAA... or {"jsonrpc": "2.0", "result": { ... }}'
            autoComplete="off"
            spellCheck={false}
          />
        )}
      </Field>
      <Button
        type="submit"
        disabled={pending}
        aria-busy={pending}
        data-contract-state={pending ? "loading" : undefined}
      >
        {pending ? "Simulating..." : copy.submit}
      </Button>
    </form>
  );
}
