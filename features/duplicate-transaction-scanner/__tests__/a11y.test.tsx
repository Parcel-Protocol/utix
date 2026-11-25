import { describe, it } from "vitest";
import { renderFeature } from "@/core/testing/render";
import { expectNoAxeViolations } from "@/core/testing/axe";
import { DuplicateScannerPanel } from "@/features/duplicate-transaction-scanner/components/DuplicateScannerPanel";

describe("DuplicateScannerPanel accessibility", () => {
  it("has no WCAG A/AA violations in its initial state", async () => {
    const { container } = renderFeature(<DuplicateScannerPanel />);
    await expectNoAxeViolations(container);
  });
});

