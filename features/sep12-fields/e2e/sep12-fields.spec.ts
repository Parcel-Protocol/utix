/**
 * End-to-end specification for the SEP-12 KYC Fields tool.
 *
 * Documented as executable steps so the behaviour is reviewable even before a
 * browser runner is wired into CI.
 */
export const spec = {
  route: "/tools/sep12-fields",
  steps: [
    { action: "visit", target: "/tools/sep12-fields" },
    { action: "expect", target: "heading", value: "SEP-12 KYC Fields" },
    { action: "click", target: "submit" },
    { action: "expect", target: "alert" }
  ]
} as const;
