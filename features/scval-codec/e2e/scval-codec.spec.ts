/**
 * End-to-end specification for the ScVal Encoder & Decoder tool.
 *
 * Documented as executable steps so the behaviour is reviewable even before a
 * browser runner is wired into CI.
 */
export const spec = {
  route: "/tools/scval-codec",
  steps: [
    { action: "visit", target: "/tools/scval-codec" },
    { action: "expect", target: "heading", value: "ScVal Encoder & Decoder" },
    { action: "click", target: "submit" },
    { action: "expect", target: "alert" }
  ]
} as const;
