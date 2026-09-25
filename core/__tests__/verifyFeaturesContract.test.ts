import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONTRACT_STATES,
  checkContractCoverage,
  evaluateContractCoverage
} from "../../scripts/verify-features.mjs";

const fixturesDir = fileURLToPath(new URL("../../scripts/__tests__/fixtures/", import.meta.url));

/**
 * Guards the checker itself, so a regression that makes the runtime contract
 * rule always pass (or always fail) is caught by the normal test run. The
 * fixture slices are read as source by the exported checker helpers; they are
 * deliberately tiny and never executed.
 */
describe("verify:features runtime contract check", () => {
  it("passes a fixture slice that drives every state through the shared harness", async () => {
    const result = await checkContractCoverage(
      "contract-good-slice",
      path.join(fixturesDir, "contract-good-slice")
    );

    expect(result.ok).toBe(true);
    expect(result.usesHarness).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it("fails a fixture slice that renders without asserting any contract state", async () => {
    const result = await checkContractCoverage(
      "contract-bad-slice",
      path.join(fixturesDir, "contract-bad-slice")
    );

    expect(result.ok).toBe(false);
    expect(result.usesHarness).toBe(false);
    expect(result.missing).toEqual([...CONTRACT_STATES]);
  });

  it("names the exact state a partially migrated slice forgets", () => {
    const result = evaluateContractCoverage("partial-slice", {
      "__tests__/panel.test.tsx": [
        'import { renderFeatureSlice } from "@/core/testing/contract";',
        'const slice = renderFeatureSlice("partial-slice", <Panel />);',
        "slice.expectEmptyState();",
        "slice.expectErrorState();"
      ].join("\n")
    });

    expect(result.ok).toBe(false);
    expect(result.usesHarness).toBe(true);
    expect(result.missing).toEqual(["loading"]);
  });
});
