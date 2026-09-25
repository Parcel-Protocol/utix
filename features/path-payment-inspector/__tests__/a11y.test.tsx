import { describe, it } from "vitest";
import { renderFeature } from "@/core/testing/render";
import { expectNoAxeViolations } from "@/core/testing/axe";
import { PathPaymentInspectorPanel } from "@/features/path-payment-inspector/components/PathPaymentInspectorPanel";

describe("PathPaymentInspectorPanel accessibility", () => {
  it("has no WCAG A/AA violations in its initial state", async () => {
    const { container } = renderFeature(<PathPaymentInspectorPanel />);
    await expectNoAxeViolations(container);
  });
});
