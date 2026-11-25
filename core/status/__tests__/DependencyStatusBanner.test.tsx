import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DependencyStatusBanner } from "../DependencyStatusBanner";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("DependencyStatusBanner", () => {
  it("shows a safe degraded notice and retries on request", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ feed: { components: [
        { id: "horizon", name: "Horizon API", status: "major_outage" }
      ] } }))
      .mockResolvedValueOnce(Response.json({ feed: { components: [
        { id: "horizon", name: "Horizon API", status: "operational" }
      ] } }));
    vi.stubGlobal("fetch", fetchMock);
    render(<DependencyStatusBanner />);

    expect(await screen.findByRole("status")).toHaveTextContent("Horizon API");
    await userEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fails visible with generic copy if the status endpoint cannot be reached", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("private host and token")));
    render(<DependencyStatusBanner />);

    expect(await screen.findByRole("status")).toHaveTextContent("Network services");
    expect(screen.getByRole("status")).not.toHaveTextContent("private host and token");
  });
});
