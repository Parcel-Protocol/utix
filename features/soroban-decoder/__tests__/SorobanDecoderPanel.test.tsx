import { describe, expect, it } from "vitest";
import { renderFeature, screen } from "@/core/testing/render";
import { SorobanDecoderPanel } from "@/features/soroban-decoder/components/SorobanDecoderPanel";
import { copy } from "@/features/soroban-decoder/copy";

describe("SorobanDecoderPanel", () => {
  it("renders empty state initially", () => {
    renderFeature(<SorobanDecoderPanel />);
    expect(screen.getByText(copy.emptyTitle)).toBeInTheDocument();
  });
});
