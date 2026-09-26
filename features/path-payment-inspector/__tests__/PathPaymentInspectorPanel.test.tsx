import { describe, expect, it } from "vitest";
import { screen } from "@/core/testing/render";
import { PathPaymentInspectorPanel } from "@/features/path-payment-inspector/components/PathPaymentInspectorPanel";
import { copy } from "@/features/path-payment-inspector/copy";
import { renderFeatureSlice } from "@/core/testing/contract";
import { PathPaymentInspectorForm } from "@/features/path-payment-inspector/components/PathPaymentInspectorForm";

describe("PathPaymentInspectorPanel", () => {
  it("renders the empty state before any input", () => {
    const slice = renderFeatureSlice("path-payment-inspector", <PathPaymentInspectorPanel />);
    slice.expectEmptyState();
    expect(screen.getByText(copy.emptyTitle)).toBeInTheDocument();
  });

  it("exposes loading through the form contract", () => {
    const slice = renderFeatureSlice("path-payment-inspector", <PathPaymentInspectorForm onSubmit={() => {}} pending />);
    slice.expectLoadingState();
  });

  it("shows a validation error when submitted empty", async () => {
    const slice = renderFeatureSlice("path-payment-inspector", <PathPaymentInspectorPanel />);
    const { user } = slice;
    await user.click(screen.getByRole("button", { name: copy.submit }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    slice.expectErrorState();
  });
});
