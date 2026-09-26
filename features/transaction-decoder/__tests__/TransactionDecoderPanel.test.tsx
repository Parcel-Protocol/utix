import { describe, expect, it } from "vitest";
import { screen } from "@/core/testing/render";
import { TransactionDecoderPanel } from "@/features/transaction-decoder/components/TransactionDecoderPanel";
import { copy } from "@/features/transaction-decoder/copy";
import { renderFeatureSlice } from "@/core/testing/contract";
import { TransactionDecoderForm } from "@/features/transaction-decoder/components/TransactionDecoderForm";

describe("TransactionDecoderPanel", () => {
  it("renders empty state initially", () => {
    const slice = renderFeatureSlice("transaction-decoder", <TransactionDecoderPanel />);
    slice.expectEmptyState();
    expect(screen.getByText(copy.emptyTitle)).toBeInTheDocument();
  });

  it("exposes loading and error contract states", async () => {
    const loading = renderFeatureSlice("transaction-decoder", <TransactionDecoderForm onSubmit={() => {}} pending />);
    loading.expectLoadingState();
    loading.unmount();
    const error = renderFeatureSlice("transaction-decoder", <TransactionDecoderPanel />);
    await error.user.click(screen.getByRole("button", { name: copy.submit }));
    error.expectErrorState();
  });
});
