"use client";

import { type FormEvent } from "react";
import { Button } from "@/core/ui/Button";
import { copy } from "@/features/keypair-generator/copy";

export function KeypairGeneratorForm({
  onSubmit,
  pending
}: {
  onSubmit: (value: string) => void;
  pending: boolean;
}) {
  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit("");
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <p className="text-sm text-slate-600">{copy.formHint}</p>
      <Button type="submit" disabled={pending}>
        {pending ? "Working..." : copy.submit}
      </Button>
    </form>
  );
}
