import { describe, it } from "vitest";
import { renderFeature } from "@/core/testing/render";
import { expectNoAxeViolations } from "@/core/testing/axe";
import { Sep12FieldsPanel } from "@/features/sep12-fields/components/Sep12FieldsPanel";

describe("Sep12FieldsPanel accessibility", () => {
  it("has no WCAG A/AA violations in its initial state", async () => {
    const { container } = renderFeature(<Sep12FieldsPanel />);
    await expectNoAxeViolations(container);
  });
});
