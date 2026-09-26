// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { expectNoAxeViolations } from "@/core/testing/axe";
import { OperationCard } from "@/features/transaction-decoder/components/OperationCard";

const operation = {
  index: 0, type: "invokeHostFunction", sourceAccount: null,
  isCancelOffer: false, isSponsorship: false, isMuxedDestination: false, labels: [],
  details: { contract: { function: { arguments: { authorization: { credentials: { address: "GABC" } } } } } }
};

describe("transaction operation inspection tree", () => {
  it("exposes deep structure and keyboard navigation without axe violations", async () => {
    const { container } = render(<OperationCard op={operation} />);
    screen.getByRole("tree", { name: "Operation 1 details" });
    const items = screen.getAllByRole("treeitem");
    expect(items.some((item) => item.getAttribute("aria-level") === "6")).toBe(true);
    expect(items[0].getAttribute("aria-expanded")).toBe("true");
    items[0].focus();
    fireEvent.keyDown(items[0], { key: "ArrowDown" });
    await waitFor(() => expect(document.activeElement).toBe(items[1]));
    fireEvent.keyDown(items[1], { key: "ArrowLeft" });
    expect(items[1].getAttribute("aria-expanded")).toBe("false");
    await expectNoAxeViolations(container);
  });
});
