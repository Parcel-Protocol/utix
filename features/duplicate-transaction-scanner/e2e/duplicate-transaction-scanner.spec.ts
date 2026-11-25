export const spec = {
  route: "/tools/duplicate-transaction-scanner",
  steps: [
    { action: "visit", target: "/tools/duplicate-transaction-scanner" },
    { action: "expect", target: "heading", value: "Duplicate Transaction Scanner" },
    { action: "expect", target: "text", value: "No scan yet" },

    // Empty submission error
    { action: "click", target: "Scan for Duplicates" },

    // Fill valid hashes
    { action: "fill", target: "Transaction Hashes", value: "<sample transaction hashes>" },
    { action: "click", target: "Scan for Duplicates" },

    // View candidate duplicate group
    { action: "expect", target: "text", value: "Fingerprint" },
    { action: "expect", target: "button", value: "Confirm Duplicate" },
    { action: "expect", target: "button", value: "Dismiss" },
    { action: "expect", target: "button", value: "Defer" }
  ]
} as const;

