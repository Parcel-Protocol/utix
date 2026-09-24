export const spec = {
  route: "/tools/soroban-decoder",
  steps: [
    { action: "visit", target: "/tools/soroban-decoder" },
    { action: "expect", target: "heading", value: "Soroban Contract Invocation Decoder" }
  ]
} as const;
