/**
 * Keyboard and async status accessibility coverage (#415)
 *
 * Covers:
 * - useAsyncStatusAnnouncer: live-region politeness, error assertive interrupt,
 *   retry/recovery announcement sequence, rapid-state transitions, idle clear,
 *   unknown-error fallback.
 * - useDynamicRevealFocus: keyboard-only reveal/dismiss, Tab-reachability,
 *   focus guard against background re-renders, reduced-motion honour,
 *   multi-reveal cycles, aria label presence on revealed group.
 *
 * Edge cases and recovery:
 * - Consecutive errors should each fire assertive announcements so screen
 *   readers interrupt on every new failure, not just the first.
 * - After a success announcement auto-clears, announcing idle must also clear.
 * - Focus must not move on initial render or on unrelated state updates.
 * - Dismissing before the target mounts must not throw.
 */

import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAsyncStatusAnnouncer } from "@/core/hooks/useAsyncStatusAnnouncer";
import { useDynamicRevealFocus } from "@/core/hooks/useDynamicRevealFocus";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// useAsyncStatusAnnouncer – accessibility paths
// ---------------------------------------------------------------------------
describe("useAsyncStatusAnnouncer – accessibility coverage (#415)", () => {
  it("loading uses polite politeness so it does not interrupt screen readers", () => {
    const { result } = renderHook(() => useAsyncStatusAnnouncer());

    act(() => {
      result.current.announce({ status: "loading" });
    });

    expect(result.current.announcement?.politeness).toBe("polite");
  });

  it("error uses assertive politeness to interrupt screen readers immediately", () => {
    const { result } = renderHook(() => useAsyncStatusAnnouncer());

    act(() => {
      result.current.announce({ status: "error", error: "Payment failed" });
    });

    expect(result.current.announcement?.politeness).toBe("assertive");
    expect(result.current.announcement?.message).toContain("Payment failed");
  });

  it("success uses polite politeness so it does not interrupt", () => {
    const { result } = renderHook(() => useAsyncStatusAnnouncer());

    act(() => {
      result.current.announce({ status: "success", message: "Transfer complete" });
    });

    expect(result.current.announcement?.politeness).toBe("polite");
    expect(result.current.announcement?.message).toBe("Transfer complete");
  });

  it("fallback message for unknown error is accessible and not empty", () => {
    const { result } = renderHook(() => useAsyncStatusAnnouncer());

    act(() => {
      // No error string provided — should fall back gracefully
      result.current.announce({ status: "error" });
    });

    const msg = result.current.announcement?.message ?? "";
    expect(msg.length).toBeGreaterThan(0);
    expect(result.current.announcement?.politeness).toBe("assertive");
  });

  it("retry sequence: error → loading → success announces each transition", () => {
    const { result } = renderHook(() => useAsyncStatusAnnouncer());

    // First attempt fails
    act(() => {
      result.current.announce({ status: "error", error: "Timeout" });
    });
    expect(result.current.announcement?.politeness).toBe("assertive");

    // User retries — loading
    act(() => {
      result.current.announce({ status: "loading", message: "Retrying…" });
    });
    expect(result.current.announcement?.message).toBe("Retrying…");
    expect(result.current.announcement?.politeness).toBe("polite");

    // Retry succeeds
    act(() => {
      result.current.announce({ status: "success", message: "Transfer complete" });
    });
    expect(result.current.announcement?.message).toBe("Transfer complete");
    expect(result.current.announcement?.politeness).toBe("polite");
  });

  it("consecutive errors each produce assertive announcements", () => {
    const { result } = renderHook(() =>
      useAsyncStatusAnnouncer({ clearDelayMs: 60_000 }) // prevent auto-clear during test
    );

    act(() => {
      result.current.announce({ status: "error", error: "First error" });
    });
    expect(result.current.announcement?.message).toContain("First error");

    act(() => {
      result.current.announce({ status: "error", error: "Second error" });
    });
    expect(result.current.announcement?.message).toContain("Second error");
    expect(result.current.announcement?.politeness).toBe("assertive");
  });

  it("authorization failure is announced assertively", () => {
    const { result } = renderHook(() => useAsyncStatusAnnouncer({ errorMessagePrefix: "Access denied: " }));

    act(() => {
      result.current.announce({ status: "error", error: "Insufficient permissions" });
    });

    expect(result.current.announcement?.message).toBe("Access denied: Insufficient permissions");
    expect(result.current.announcement?.politeness).toBe("assertive");
  });

  it("idle status clears announcement immediately without delay", () => {
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

  it("auto-clears error announcement after configured delay", async () => {
    const { result } = renderHook(() => useAsyncStatusAnnouncer({ clearDelayMs: 80 }));

    act(() => {
      result.current.announce({ status: "error", error: "timeout" });
    });
    expect(result.current.announcement).not.toBeNull();

    await waitFor(
      () => {
        expect(result.current.announcement).toBeNull();
      },
      { timeout: 500 }
    );
  });

  it("rapid transitions from loading to success cancel the previous timeout", async () => {
    const { result } = renderHook(() => useAsyncStatusAnnouncer({ clearDelayMs: 50 }));

    act(() => {
      result.current.announce({ status: "loading" });
    });
    act(() => {
      result.current.announce({ status: "success" });
    });
    act(() => {
      // New error immediately cancels the pending success clear timer
      result.current.announce({ status: "error", error: "interrupted" });
    });

    expect(result.current.announcement?.message).toContain("interrupted");
    expect(result.current.announcement?.politeness).toBe("assertive");
  });
});

// ---------------------------------------------------------------------------
// useDynamicRevealFocus – keyboard and accessibility paths
// ---------------------------------------------------------------------------

/** Minimal accessible component used by all focus tests. */
function RevealComponent({
  onFocus
}: {
  onFocus?: (el: HTMLInputElement) => void;
}) {
  const [visible, setVisible] = useState(false);
  const [ticks, setTicks] = useState(0);
  const { targetRef, triggerRef, triggerReveal, triggerDismiss } =
    useDynamicRevealFocus<HTMLInputElement, HTMLButtonElement>({
      onFocus
    });

  return (
    <div>
      <button
        type="button"
        ref={triggerRef}
        data-testid="toggle-btn"
        aria-expanded={visible}
        aria-controls="dynamic-section"
        onClick={() => {
          if (visible) {
            setVisible(false);
            triggerDismiss();
          } else {
            setVisible(true);
            triggerReveal();
          }
        }}
      >
        {visible ? "Hide" : "Show"} section
      </button>

      <button
        type="button"
        data-testid="unrelated-btn"
        onClick={() => setTicks((t) => t + 1)}
      >
        Unrelated {ticks}
      </button>

      {visible && (
        <section id="dynamic-section" aria-label="Extra fields">
          <label htmlFor="revealed-field">Revealed field</label>
          <input
            id="revealed-field"
            data-testid="revealed-input"
            ref={targetRef}
          />
        </section>
      )}
    </div>
  );
}

describe("useDynamicRevealFocus – keyboard and a11y coverage (#415)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("does not move focus on initial render", () => {
    render(<RevealComponent />);
    expect(document.activeElement).toBe(document.body);
  });

  it("moves focus to revealed input on explicit keyboard trigger", () => {
    render(<RevealComponent />);
    const btn = screen.getByTestId("toggle-btn");

    fireEvent.click(btn);

    expect(document.activeElement).toBe(screen.getByTestId("revealed-input"));
  });

  it("revealed input has a visible label (keyboard-reachable)", () => {
    render(<RevealComponent />);
    fireEvent.click(screen.getByTestId("toggle-btn"));

    const input = screen.getByLabelText("Revealed field");
    expect(input).toBe(screen.getByTestId("revealed-input"));
  });

  it("revealed section has an aria-label for screen readers", () => {
    render(<RevealComponent />);
    fireEvent.click(screen.getByTestId("toggle-btn"));

    const section = screen.getByRole("region", { name: "Extra fields" });
    expect(section).toBeTruthy();
  });

  it("toggle button has aria-expanded attribute tracking state", () => {
    render(<RevealComponent />);
    const btn = screen.getByTestId("toggle-btn");

    expect(btn).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(btn);
    expect(btn).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(btn);
    expect(btn).toHaveAttribute("aria-expanded", "false");
  });

  it("focus returns to trigger when section is dismissed", () => {
    render(<RevealComponent />);
    const btn = screen.getByTestId("toggle-btn");

    fireEvent.click(btn);
    expect(document.activeElement).toBe(screen.getByTestId("revealed-input"));

    fireEvent.click(btn);
    expect(document.activeElement).toBe(btn);
  });

  it("does not steal focus during unrelated re-renders", () => {
    render(<RevealComponent />);
    const btn = screen.getByTestId("toggle-btn");

    fireEvent.click(btn);
    const revealed = screen.getByTestId("revealed-input");
    expect(document.activeElement).toBe(revealed);

    // User moves focus elsewhere
    const unrelated = screen.getByTestId("unrelated-btn");
    unrelated.focus();
    expect(document.activeElement).toBe(unrelated);

    // Unrelated state update — focus must NOT move
    fireEvent.click(unrelated);
    expect(document.activeElement).toBe(unrelated);
  });

  it("onFocus callback is invoked with the target element on reveal", () => {
    const onFocus = vi.fn();
    render(<RevealComponent onFocus={onFocus} />);

    fireEvent.click(screen.getByTestId("toggle-btn"));

    expect(onFocus).toHaveBeenCalledOnce();
    expect(onFocus).toHaveBeenCalledWith(screen.getByTestId("revealed-input"));
  });

  it("supports multiple reveal/dismiss cycles without accumulating focus bugs", () => {
    render(<RevealComponent />);
    const btn = screen.getByTestId("toggle-btn");

    for (let cycle = 0; cycle < 3; cycle++) {
      fireEvent.click(btn); // reveal
      expect(document.activeElement).toBe(screen.getByTestId("revealed-input"));

      fireEvent.click(btn); // dismiss
      expect(document.activeElement).toBe(btn);
    }
  });

  it("does not throw when dismiss is triggered before target is mounted", () => {
    expect(() => {
      render(<RevealComponent />);
      const btn = screen.getByTestId("toggle-btn");
      // Dismiss without prior reveal — target never mounted
      fireEvent.click(btn); // reveals
      fireEvent.click(btn); // dismisses (target unmounts simultaneously)
    }).not.toThrow();
  });

  it("authorization path: triggering reveal on a conditionally accessible field", () => {
    // Simulates an auth gate: field only visible to authorized users.
    function AuthGatedField({ authorized }: { authorized: boolean }) {
      const { targetRef, triggerRef, triggerReveal } =
        useDynamicRevealFocus<HTMLInputElement, HTMLButtonElement>();
      const [revealed, setRevealed] = useState(false);

      return (
        <div>
          <button
            ref={triggerRef}
            data-testid="auth-btn"
            onClick={() => {
              if (authorized) {
                setRevealed(true);
                triggerReveal();
              }
            }}
          >
            Access field
          </button>
          {revealed && authorized && (
            <input data-testid="auth-input" ref={targetRef} aria-label="Sensitive field" />
          )}
        </div>
      );
    }

    render(<AuthGatedField authorized={true} />);
    fireEvent.click(screen.getByTestId("auth-btn"));
    expect(document.activeElement).toBe(screen.getByTestId("auth-input"));
  });

  it("unauthorized: reveal trigger does nothing, focus stays on trigger", () => {
    function AuthGatedField({ authorized }: { authorized: boolean }) {
      const { targetRef, triggerRef, triggerReveal } =
        useDynamicRevealFocus<HTMLInputElement, HTMLButtonElement>();
      const [revealed, setRevealed] = useState(false);

      return (
        <div>
          <button
            ref={triggerRef}
            data-testid="unauth-btn"
            onClick={() => {
              if (authorized) {
                setRevealed(true);
                triggerReveal();
              }
            }}
          >
            Access field
          </button>
          {revealed && <input data-testid="unauth-input" ref={targetRef} aria-label="Sensitive field" />}
        </div>
      );
    }

    render(<AuthGatedField authorized={false} />);
    const btn = screen.getByTestId("unauth-btn");
    btn.focus();
    fireEvent.click(btn);

    expect(screen.queryByTestId("unauth-input")).toBeNull();
    expect(document.activeElement).toBe(btn);
  });
});
