import { describe, expect, it } from "vitest";
import { renderFeature, screen } from "@/core/testing/render";
import { TransactionDecoderPanel } from "@/features/transaction-decoder/components/TransactionDecoderPanel";
import { copy } from "@/features/transaction-decoder/copy";

describe("TransactionDecoderPanel", () => {
  it("renders empty state initially", () => {
    renderFeature(<TransactionDecoderPanel />);
    expect(screen.getByText(copy.emptyTitle)).toBeInTheDocument();
  });
});
