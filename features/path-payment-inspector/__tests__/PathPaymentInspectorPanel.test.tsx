import { describe, expect, it } from "vitest";
import { renderFeature, screen } from "@/core/testing/render";
import { PathPaymentInspectorPanel } from "@/features/path-payment-inspector/components/PathPaymentInspectorPanel";
import { copy } from "@/features/path-payment-inspector/copy";

describe("PathPaymentInspectorPanel", () => {
  it("renders the empty state before any input", () => {
    renderFeature(<PathPaymentInspectorPanel />);
    expect(screen.getByText(copy.emptyTitle)).toBeInTheDocument();
  });

  it("shows a validation error when submitted empty", async () => {
    const { user } = renderFeature(<PathPaymentInspectorPanel />);
    await user.click(screen.getByRole("button", { name: copy.submit }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });
});
