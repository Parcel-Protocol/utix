import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderFeatureSlice } from "@/core/testing/contract";
import { Sep12FieldsPanel } from "@/features/sep12-fields/components/Sep12FieldsPanel";
import { copy } from "@/features/sep12-fields/copy";

describe("SEP-12 field reference runtime contract", () => {
  it("shows empty, loading, and a searchable result", async () => {
    const slice = renderFeatureSlice("sep12-fields", <Sep12FieldsPanel />);
    slice.expectEmptyState();
    const input = screen.getByLabelText(new RegExp(copy.formLabel, "i"));
    await slice.user.type(input, "country");
    await slice.user.click(screen.getByRole("button", { name: copy.submit }));
    slice.expectLoadingState();
    await slice.waitForState("success");
    expect(screen.getByText("country")).toBeInTheDocument();
  });

  it("shows an error for an unknown field", async () => {
    const slice = renderFeatureSlice("sep12-fields", <Sep12FieldsPanel />);
    const input = screen.getByLabelText(new RegExp(copy.formLabel, "i"));
    await slice.user.type(input, "no-such-standard-field");
    await slice.user.click(screen.getByRole("button", { name: copy.submit }));
    await slice.waitForState("error");
    slice.expectErrorState();
  });
});
