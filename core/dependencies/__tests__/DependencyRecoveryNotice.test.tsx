import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DependencyRecoveryNotice } from "../DependencyRecoveryNotice";

describe("DependencyRecoveryNotice", () => {
  it("shows recovery copy and retries when activated", async () => {
    const retry = vi.fn();
    const user = userEvent.setup();
    render(
      <DependencyRecoveryNotice
        dependency="horizon"
        message="Live data is temporarily unavailable."
        onRetry={retry}
      />
    );
    expect(screen.getByRole("status")).toHaveAttribute("data-dependency", "horizon");
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it("disables retry while recovery is in progress", () => {
    render(
      <DependencyRecoveryNotice
        dependency="soroban_rpc"
        message="Simulation is temporarily unavailable."
        retrying
        onRetry={() => undefined}
      />
    );
    expect(screen.getByRole("button", { name: "Retrying..." })).toBeDisabled();
  });
});
