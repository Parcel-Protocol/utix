import { describe, expect, it } from "vitest";
import { screen } from "@/core/testing/render";
import { SimulationExplainerPanel } from "@/features/simulation-explainer/components/SimulationExplainerPanel";
import { SimulationExplainerForm } from "@/features/simulation-explainer/components/SimulationExplainerForm";
import { copy } from "@/features/simulation-explainer/copy";
import { renderFeatureSlice } from "@/core/testing/contract";

describe("SimulationExplainerPanel", () => {
  it("renders empty state initially", () => {
    const slice = renderFeatureSlice("simulation-explainer", <SimulationExplainerPanel />);
    slice.expectEmptyState();
    expect(screen.getByText(copy.emptyTitle)).toBeInTheDocument();
  });

  it("exposes loading and error contract states", async () => {
    const loading = renderFeatureSlice(
      "simulation-explainer",
      <SimulationExplainerForm onSubmit={() => {}} pending />
    );
    loading.expectLoadingState();
    loading.unmount();

    const error = renderFeatureSlice("simulation-explainer", <SimulationExplainerPanel />);
    await error.user.click(screen.getByRole("button", { name: copy.submit }));
    error.expectErrorState();
  });

  it("renders simulation diagnostics for raw simulation response JSON", async () => {
    const slice = renderFeatureSlice("simulation-explainer", <SimulationExplainerPanel />);
    const rawJson = JSON.stringify({
      latestLedger: 12345,
      cost: { cpuInsns: "1000", memBytes: "100" },
      minResourceFee: "5000"
    });

    await slice.user.type(screen.getByLabelText(copy.formLabel), rawJson);
    await slice.user.click(screen.getByRole("button", { name: copy.submit }));

    expect(await screen.findByText(copy.resultTitle)).toBeInTheDocument();
    expect(screen.getByText(copy.statusSuccess)).toBeInTheDocument();
  });
});
