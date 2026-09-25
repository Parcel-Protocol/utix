import { expect } from "vitest";
import type { ReactElement } from "react";
import { renderFeature, waitFor, type RenderFeatureOptions } from "@/core/testing/render";

/** Stable id `scripts/verify-features.mjs` looks for in a slice's test sources. */
export const CONTRACT_HARNESS_ID = "@core/testing/contract";

/**
 * DOM attribute the shared state primitives render (`EmptyState` → "empty",
 * `StatusMessage` → its type, `Skeleton`/`SkeletonRows` → "loading"). Slices
 * that hand-roll an indicator can add it too, which is what keeps these
 * helpers identical across structurally different tools.
 */
export const CONTRACT_STATE_ATTRIBUTE = "data-contract-state";

/**
 * The states every slice must exercise at runtime. Mirrors `CONTRACT_STATES`
 * in scripts/verify-features.mjs and the checklist in docs/FEATURE_CONTRACT.md.
 */
export const FEATURE_CONTRACT_STATES = ["loading", "error", "empty"] as const;

export type FeatureContractState = (typeof FEATURE_CONTRACT_STATES)[number];

/**
 * How each state is detected. The shared primitives render
 * `data-contract-state`; the role/aria fallbacks cover slices that hand-roll an
 * indicator without the primitive.
 */
const STATE_SELECTORS: Record<FeatureContractState, string> = {
  loading: `[${CONTRACT_STATE_ATTRIBUTE}="loading"], [role="progressbar"], [aria-busy="true"]`,
  error: `[${CONTRACT_STATE_ATTRIBUTE}="error"], [role="alert"]`,
  empty: `[${CONTRACT_STATE_ATTRIBUTE}="empty"]`
};

function findState(state: FeatureContractState): Element | null {
  return document.querySelector(STATE_SELECTORS[state]);
}

export type FeatureSliceHarness = ReturnType<typeof renderFeature> & {
  /** Slice slug under test — used in failure messages. */
  id: string;
  /** True while the slice is showing the given contract state. */
  hasState(state: FeatureContractState): boolean;
  /** Assert synchronously that a contract state is on screen. */
  expectState(state: FeatureContractState): void;
  expectLoadingState(): void;
  expectErrorState(): void;
  expectEmptyState(): void;
  /** Wait for an asynchronous transition into a contract state. */
  waitForState(state: FeatureContractState): Promise<void>;
};

/**
 * Mounts a slice's panel inside the real providers and returns assertions
 * bound to it, so every slice's component test drives the same
 * loading → data → error lifecycle through one shared API:
 *
 * ```tsx
 * const slice = renderFeatureSlice("balance-viewer", <BalanceViewerPanel />);
 * slice.expectEmptyState();
 * await user.click(screen.getByRole("button", { name: copy.submit }));
 * await slice.waitForState("loading");
 * await slice.waitForState("error");
 * ```
 *
 * The helpers assert against the state primitives rather than copy, so they
 * work unchanged across a lookup form, a QR generator and a wallet-connect
 * flow. `npm run verify:features` requires each slice's suite to call
 * `expectLoadingState`, `expectErrorState` and `expectEmptyState`.
 */
export function renderFeatureSlice(
  id: string,
  ui: ReactElement,
  options: RenderFeatureOptions = {}
): FeatureSliceHarness {
  const rendered = renderFeature(ui, options);

  const hasState = (state: FeatureContractState): boolean => findState(state) !== null;

  const expectState = (state: FeatureContractState): void => {
    expect(
      hasState(state),
      `expected slice "${id}" to render its "${state}" contract state ` +
        `(selector: ${STATE_SELECTORS[state]}) — ` +
        "see docs/FEATURE_CONTRACT.md#runtime-contract-compatibility"
    ).toBe(true);
  };

  return {
    id,
    ...rendered,
    hasState,
    expectState,
    expectLoadingState: () => expectState("loading"),
    expectErrorState: () => expectState("error"),
    expectEmptyState: () => expectState("empty"),
    waitForState: (state) => waitFor(() => expectState(state))
  };
}
