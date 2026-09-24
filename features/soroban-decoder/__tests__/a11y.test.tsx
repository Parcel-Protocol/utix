import { describe, it } from "vitest";
import { renderFeature } from "@/core/testing/render";
import { expectNoAxeViolations } from "@/core/testing/axe";
import { SorobanDecoderPanel } from "@/features/soroban-decoder/components/SorobanDecoderPanel";

describe("SorobanDecoderPanel accessibility", () => {
  it("has no WCAG violations initially", async () => {
    const { container } = renderFeature(<SorobanDecoderPanel />);
    await expectNoAxeViolations(container);
  });
});
