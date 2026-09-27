/**
 * End-to-end specification for the Soroban Simulation Result Explainer tool.
 *
 * Documented as executable steps so the behaviour is reviewable even before a
 * browser runner is wired into CI.
 */
export const spec = {
  route: "/tools/simulation-explainer",
  steps: [
    { action: "visit", target: "/tools/simulation-explainer" },
    { action: "expect", target: "heading", value: "Soroban Simulation Result Explainer" },
    { action: "click", target: "submit" },
    { action: "expect", target: "alert" }
  ]
} as const;
