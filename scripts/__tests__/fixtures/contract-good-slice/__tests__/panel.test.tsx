import { describe, it } from "vitest";
import { renderFeatureSlice } from "@/core/testing/contract";
import { ContractFixturePanel } from "../panel";

/**
 * Fixture slice for the verify:features runtime contract check (good case):
 * every required state is exercised through the shared harness.
 */
describe("contract-good-slice", () => {
  it("exercises empty, error and loading through the shared harness", async () => {
    const slice = renderFeatureSlice("contract-good-slice", <ContractFixturePanel />);

    slice.expectEmptyState();
    slice.expectErrorState();
    await slice.waitForState("loading");
  });
});
