import { describe, it } from "vitest";
import { renderFeature } from "@/core/testing/render";
import { expectNoAxeViolations } from "@/core/testing/axe";
import { SimulationExplainerPanel } from "@/features/simulation-explainer/components/SimulationExplainerPanel";

describe("SimulationExplainerPanel accessibility", () => {
  it("has no WCAG A/AA violations in its initial state", async () => {
    const { container } = renderFeature(<SimulationExplainerPanel />);
    await expectNoAxeViolations(container);
  });
});
