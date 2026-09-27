import { describe, expect, it } from "vitest";
import { screen } from "@/core/testing/render";
import { ClaimablePredicateBuilderPanel } from "@/features/claimable-predicate-builder/components/ClaimablePredicateBuilderPanel";
import { ClaimablePredicateBuilderForm } from "@/features/claimable-predicate-builder/components/ClaimablePredicateBuilderForm";
import { copy } from "@/features/claimable-predicate-builder/copy";
import { renderFeatureSlice } from "@/core/testing/contract";

describe("ClaimablePredicateBuilderPanel", () => {
  it("renders empty state initially", () => {
    const slice = renderFeatureSlice(
      "claimable-predicate-builder",
      <ClaimablePredicateBuilderPanel />
    );
    slice.expectEmptyState();
    expect(screen.getByText(copy.emptyTitle)).toBeInTheDocument();
  });

  it("exposes loading and error contract states", async () => {
    const loading = renderFeatureSlice(
      "claimable-predicate-builder",
      <ClaimablePredicateBuilderForm onSubmit={() => {}} pending />
    );
    loading.expectLoadingState();
    loading.unmount();

    const error = renderFeatureSlice(
      "claimable-predicate-builder",
      <ClaimablePredicateBuilderPanel />
    );
    await error.user.click(screen.getByRole("button", { name: copy.submit }));
    error.expectErrorState();
  });

  it("builds and displays predicate result when submitted with a valid template", async () => {
    const slice = renderFeatureSlice(
      "claimable-predicate-builder",
      <ClaimablePredicateBuilderPanel />
    );
    await slice.user.click(screen.getByRole("button", { name: copy.templateTimelock }));
    await slice.user.click(screen.getByRole("button", { name: copy.submit }));

    expect(await screen.findByText(copy.resultTitle)).toBeInTheDocument();
    expect(screen.getByText(copy.plainLanguageTitle)).toBeInTheDocument();
  });
});
