import { describe, expect, it } from "vitest";
import { renderFeature, screen } from "@/core/testing/render";
import { Sep12FieldsPanel } from "@/features/sep12-fields/components/Sep12FieldsPanel";
import { copy } from "@/features/sep12-fields/copy";

describe("Sep12FieldsPanel", () => {
  it("renders the empty state before any input", () => {
    renderFeature(<Sep12FieldsPanel />);
    expect(screen.getByText(copy.emptyTitle)).toBeInTheDocument();
  });

  it("shows a validation error when submitted empty", async () => {
    const { user } = renderFeature(<Sep12FieldsPanel />);
    await user.click(screen.getByRole("button", { name: copy.submit }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });
});
