import { describe, expect, it } from "vitest";
import { screen } from "@/core/testing/render";
import { SorobanDecoderPanel } from "@/features/soroban-decoder/components/SorobanDecoderPanel";
import { copy } from "@/features/soroban-decoder/copy";
import { renderFeatureSlice } from "@/core/testing/contract";
import { SorobanDecoderForm } from "@/features/soroban-decoder/components/SorobanDecoderForm";

describe("SorobanDecoderPanel", () => {
  it("renders empty state initially", () => {
    const slice = renderFeatureSlice("soroban-decoder", <SorobanDecoderPanel />);
    slice.expectEmptyState();
    expect(screen.getByText(copy.emptyTitle)).toBeInTheDocument();
  });

  it("exposes loading and error contract states", async () => {
    const loading = renderFeatureSlice("soroban-decoder", <SorobanDecoderForm onSubmit={() => {}} pending />);
    loading.expectLoadingState();
    loading.unmount();
    const error = renderFeatureSlice("soroban-decoder", <SorobanDecoderPanel />);
    await error.user.click(screen.getByRole("button", { name: copy.submit }));
    error.expectErrorState();
  });
});
