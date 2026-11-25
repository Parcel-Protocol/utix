import { describe, expect, it } from "vitest";
import { screen } from "@/core/testing/render";
import { renderFeatureSlice } from "@/core/testing/contract";
import { DuplicateScannerPanel } from "@/features/duplicate-transaction-scanner/components/DuplicateScannerPanel";
import { SkeletonRows } from "@/core/ui";
import { copy } from "@/features/duplicate-transaction-scanner/copy";

describe("DuplicateScannerPanel", () => {
  it("renders empty state initially", () => {
    const slice = renderFeatureSlice("duplicate-transaction-scanner", <DuplicateScannerPanel />);
    slice.expectEmptyState();
    expect(screen.getByText(copy.emptyHeading)).toBeInTheDocument();
  });

  it("exposes loading and error contract states", async () => {
    const loading = renderFeatureSlice("duplicate-transaction-scanner", <SkeletonRows count={3} />);
    loading.expectLoadingState();
    loading.unmount();

    const error = renderFeatureSlice("duplicate-transaction-scanner", <DuplicateScannerPanel />);
    await error.user.type(screen.getByLabelText(copy.hashesLabel), "not-a-valid-hash\n");
    await error.user.click(screen.getByRole("button", { name: copy.submitLabel }));
    error.expectErrorState();
  });
});

