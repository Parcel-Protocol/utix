"use client";

import { useState, type FormEvent } from "react";
import { Button } from "@/core/ui/Button";
import { Field } from "@/core/ui/Field";
import { Input } from "@/core/ui/Input";
import { copy } from "@/features/claimable-predicate-builder/copy";
import type { PredicateNode } from "@/features/claimable-predicate-builder/types";
import {
  astToBase64,
  getTemplateNode
} from "@/features/claimable-predicate-builder/lib/claimablePredicateBuilder";
import { PredicateNodeEditor } from "@/features/claimable-predicate-builder/components/PredicateNodeEditor";

export function ClaimablePredicateBuilderForm({
  onSubmit,
  pending
}: {
  onSubmit: (value: string) => void;
  pending: boolean;
}) {
  const [value, setValue] = useState("");
  const [rootNode, setRootNode] = useState<PredicateNode>(() =>
    getTemplateNode("unconditional")
  );

  function handleNodeChange(updated: PredicateNode) {
    setRootNode(updated);
    try {
      const b64 = astToBase64(updated);
      setValue(b64);
    } catch {
      // Ignore intermediate tree states
    }
  }

  function handleSelectTemplate(template: "unconditional" | "timelock" | "window" | "grace") {
    const node = getTemplateNode(template);
    setRootNode(node);
    try {
      const b64 = astToBase64(node);
      setValue(b64);
    } catch {
      // Ignore
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit(value);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div>
        <span className="block text-xs font-semibold uppercase tracking-wider text-[#4A5568] dark:text-[#A0AEC0] mb-2">
          Preset Templates
        </span>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => handleSelectTemplate("unconditional")}
          >
            {copy.templateUnconditional}
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => handleSelectTemplate("timelock")}
          >
            {copy.templateTimelock}
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => handleSelectTemplate("window")}
          >
            {copy.templateWindow}
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => handleSelectTemplate("grace")}
          >
            {copy.templateGrace}
          </Button>
        </div>
      </div>

      <div className="space-y-2">
        <span className="block text-sm font-semibold text-[#172033] dark:text-white">
          {copy.treeHeading}
        </span>
        <PredicateNodeEditor node={rootNode} onChange={handleNodeChange} />
      </div>

      <Field label={copy.formLabel} hint={copy.formHint}>
        {({ inputId, describedBy, invalid }) => (
          <Input
            id={inputId}
            aria-describedby={describedBy}
            aria-invalid={invalid}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="e.g. AAAAAQAAAAIAAAAAAAAAAAAEAAAAAGVT8QA="
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
        {pending ? "Encoding..." : copy.submit}
      </Button>
    </form>
  );
}
