import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderFeatureSlice } from "@/core/testing/contract";
import { KeypairGeneratorPanel } from "@/features/keypair-generator/components/KeypairGeneratorPanel";
import { copy } from "@/features/keypair-generator/copy";

describe("keypair generator runtime contract", () => {
  it("starts empty and reaches loading then success", async () => {
    const slice = renderFeatureSlice("keypair-generator", <KeypairGeneratorPanel />);
    slice.expectEmptyState();
    await slice.user.click(screen.getByRole("button", { name: copy.submit }));
    slice.expectLoadingState();
    await slice.waitForState("success");
    expect(screen.getByText(copy.resultTitle)).toBeInTheDocument();
  });

  it.skip("documents the failure contract when browser CSPRNG is unavailable", () => {
    const slice = renderFeatureSlice("keypair-generator", <KeypairGeneratorPanel />);
    slice.expectErrorState();
  });
});
