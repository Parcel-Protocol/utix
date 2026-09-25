import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { ContractFixturePanel } from "../panel";

/**
 * Fixture slice for the verify:features runtime contract check (bad case): a
 * test file exists, but nothing asserts the loading/error/empty states — the
 * exact "has a test file" false positive the checker must reject.
 */
describe("contract-bad-slice", () => {
  it("renders the panel", () => {
    const { container } = render(<ContractFixturePanel />);

    expect(container.querySelector("div")).not.toBeNull();
  });
});
