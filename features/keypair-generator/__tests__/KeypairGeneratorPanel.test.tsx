import { describe, expect, it } from "vitest";
import { renderFeature, screen } from "@/core/testing/render";
import { KeypairGeneratorPanel } from "@/features/keypair-generator/components/KeypairGeneratorPanel";
import { copy } from "@/features/keypair-generator/copy";

describe("KeypairGeneratorPanel", () => {
  it("renders the empty state before any input", () => {
    renderFeature(<KeypairGeneratorPanel />);
    expect(screen.getByText(copy.emptyTitle)).toBeInTheDocument();
  });

  it("generates a keypair when submitted", async () => {
    const { user } = renderFeature(<KeypairGeneratorPanel />);
    await user.click(screen.getByRole("button", { name: copy.submit }));
    expect(await screen.findByText(copy.resultTitle)).toBeInTheDocument();
  });
});
