import { renderHook, act, waitFor } from "@/core/testing";
import { useAsyncStatusAnnouncer } from "@/core/hooks/useAsyncStatusAnnouncer";
import { describe, it, expect } from "vitest";

describe("useAsyncStatusAnnouncer", () => {
  it("announces loading state with polite politeness", () => {
    const { result } = renderHook(() => useAsyncStatusAnnouncer());

    act(() => {
      result.current.announce({ status: "loading" });
    });

    expect(result.current.announcement).toEqual({
      message: "Loading...",
      politeness: "polite"
    });
  });

  it("uses custom loading message", () => {
    const { result } = renderHook(() =>
      useAsyncStatusAnnouncer({ loadingMessage: "Fetching data..." })
    );

    act(() => {
      result.current.announce({ status: "loading", message: "Fetching data..." });
    });

    expect(result.current.announcement?.message).toBe("Fetching data...");
  });

  it("announces success state with polite politeness", () => {
    const { result } = renderHook(() => useAsyncStatusAnnouncer());

    act(() => {
      result.current.announce({ status: "success" });
    });

    expect(result.current.announcement).toEqual({
      message: "Success",
      politeness: "polite"
    });
  });

  it("announces error state with assertive politeness", () => {
    const { result } = renderHook(() => useAsyncStatusAnnouncer());

    act(() => {
      result.current.announce({ status: "error", error: "Network failed" });
    });

    expect(result.current.announcement).toEqual({
      message: "Error: Network failed",
      politeness: "assertive"
    });
  });

  it("clears announcement after configured delay", async () => {
    const { result } = renderHook(() =>
      useAsyncStatusAnnouncer({ clearDelayMs: 100 })
    );

    act(() => {
      result.current.announce({ status: "success" });
    });

    expect(result.current.announcement).not.toBeNull();

    await waitFor(
      () => {
        expect(result.current.announcement).toBeNull();
      },
      { timeout: 500 }
    );
  });

  it("returns to idle state", () => {
    const { result } = renderHook(() => useAsyncStatusAnnouncer());

    act(() => {
      result.current.announce({ status: "loading" });
    });

    expect(result.current.announcement).not.toBeNull();

    act(() => {
      result.current.announce({ status: "idle" });
    });

    expect(result.current.announcement).toBeNull();
  });

  it("uses custom error message prefix", () => {
    const { result } = renderHook(() =>
      useAsyncStatusAnnouncer({ errorMessagePrefix: "Failed: " })
    );

    act(() => {
      result.current.announce({ status: "error", error: "timeout" });
    });

    expect(result.current.announcement?.message).toBe("Failed: timeout");
  });

  it("cancels previous timeout when announcing new status", async () => {
    const { result } = renderHook(() =>
      useAsyncStatusAnnouncer({ clearDelayMs: 500 })
    );

    act(() => {
      result.current.announce({ status: "success" });
    });

    expect(result.current.announcement).not.toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 100));

    act(() => {
      result.current.announce({ status: "error", error: "new error" });
    });

    expect(result.current.announcement?.message).toContain("new error");
  });
});
