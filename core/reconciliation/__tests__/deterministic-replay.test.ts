// Deterministic replay tests for multi‑actor mutations
import { describe, it, expect } from "vitest";
import { ReplayHarness } from "../../reconciliation/replayHarness"; // placeholder

describe("Deterministic Replay Harness", () => {
  it("replays a successful multi‑actor mutation sequence", async () => {
    const harness = new ReplayHarness();
    // Simulate two actors
    harness.recordEvent({ actor: "A", type: "increment", payload: { key: "x", delta: 1 } });
    harness.recordEvent({ actor: "B", type: "increment", payload: { key: "x", delta: 2 } });
    const result = await harness.replay();
    expect(result.state.x).toBe(3);
  });

  it("fails and aborts on a failing mutation", async () => {
    const harness = new ReplayHarness();
    harness.recordEvent({ actor: "A", type: "increment", payload: { key: "x", delta: 1 } });
    harness.recordEvent({ actor: "B", type: "error", payload: {} }); // forces error
    await expect(harness.replay()).rejects.toThrow();
  });

  it("retries a transient failure", async () => {
    const harness = new ReplayHarness({ retries: 1 });
    let attempt = 0;
    harness.recordEvent({
      actor: "A",
      type: "maybeFail",
      payload: {},
      execute: () => {
        if (attempt++ === 0) throw new Error("Transient");
        return { success: true };
      },
    });
    const result = await harness.replay();
    expect(attempt).toBe(2);
    expect(result.success).toBeTruthy();
  });

  it("rejects unauthorized actor actions", async () => {
    const harness = new ReplayHarness({ authorizedActors: ["A"] });
    harness.recordEvent({ actor: "B", type: "increment", payload: { key: "x", delta: 1 } });
    await expect(harness.replay()).rejects.toThrow(/unauthorized/);
  });
});
