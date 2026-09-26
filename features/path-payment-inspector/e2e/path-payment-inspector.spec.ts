/**
 * End-to-end specification for the Path Payment and DEX Offer Inspector tool.
 *
 * Documented as executable steps so the behaviour is reviewable even before a
 * browser runner is wired into CI.
 */
export const spec = {
  route: "/tools/path-payment-inspector",
  steps: [
    { action: "visit", target: "/tools/path-payment-inspector" },
    { action: "expect", target: "heading", value: "Path Payment and DEX Offer Inspector" },
    { action: "click", target: "submit" },
    { action: "expect", target: "alert" }
  ]
} as const;
