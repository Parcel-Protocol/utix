/**
 * End-to-end specification for the Testnet Keypair Generator tool.
 *
 * Documented as executable steps so the behaviour is reviewable even before a
 * browser runner is wired into CI.
 */
export const spec = {
  route: "/tools/keypair-generator",
  steps: [
    { action: "visit", target: "/tools/keypair-generator" },
    { action: "expect", target: "heading", value: "Testnet Keypair Generator" },
    { action: "click", target: "submit" },
    { action: "expect", target: "alert" }
  ]
} as const;
