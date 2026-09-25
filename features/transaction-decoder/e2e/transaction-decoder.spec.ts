export const spec = {
  route: "/tools/transaction-decoder",
  steps: [
    { action: "visit", target: "/tools/transaction-decoder" },
    { action: "expect", target: "heading", value: "Transaction Decoder & Simulator" }
  ]
} as const;
