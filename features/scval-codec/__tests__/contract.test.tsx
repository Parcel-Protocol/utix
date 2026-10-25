import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderFeatureSlice } from "@/core/testing/contract";
import { ScvalCodecPanel } from "@/features/scval-codec/components/ScvalCodecPanel";
import { copy } from "@/features/scval-codec/copy";

describe("ScVal codec runtime contract", () => {
  it("shows empty, loading, and error states", async () => {
    const slice = renderFeatureSlice("scval-codec", <ScvalCodecPanel />);
    slice.expectEmptyState();
    const input = screen.getByLabelText(new RegExp(copy.formLabel, "i"));
    await slice.user.type(input, "not-base64");
    await slice.user.click(screen.getByRole("button", { name: copy.submit }));
    slice.expectLoadingState();
    await slice.waitForState("error");
    slice.expectErrorState();
  });
});
