import { describe, it } from "vitest";
import { renderFeature } from "@/core/testing/render";
import { expectNoAxeViolations } from "@/core/testing/axe";
import { TransactionDecoderPanel } from "@/features/transaction-decoder/components/TransactionDecoderPanel";

describe("TransactionDecoderPanel accessibility", () => {
  it("has no WCAG violations initially", async () => {
    const { container } = renderFeature(<TransactionDecoderPanel />);
    await expectNoAxeViolations(container);
  });
});
