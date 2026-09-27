import type { SimulationExplainerErrorCode } from "@/features/simulation-explainer/types";

export const copy = {
  formLabel: "Soroban Transaction Envelope or Simulation JSON",
  formHint: "Paste a base64 TransactionEnvelope XDR to simulate against RPC, or paste an existing simulateTransaction JSON response.",
  submit: "Explain Simulation",
  emptyTitle: "Simulate and inspect Soroban execution",
  emptyDescription: "Inspect compute resources, minimum fees, ledger footprints, auth requirements, and diagnose failure reasons before submitting to the network.",
  resultTitle: "Simulation Diagnostics & Analysis",
  statusSuccess: "Simulation Succeeded",
  statusFailed: "Simulation Failed",
  statusRestore: "State Restoration Required",
  cpuUsage: "CPU Instructions",
  memUsage: "Memory Usage",
  minResourceFee: "Min Resource Fee",
  footprintTitle: "Ledger Footprint (State Access)",
  readOnlyKeys: "Read-only Keys",
  readWriteKeys: "Read-write Keys",
  authTitle: "Authorization Requirements",
  eventsTitle: "Diagnostic Events",
  errorTitle: "Failure Diagnosis",
  rawJsonTitle: "Raw RPC Simulation Response"
} as const;

export const errorCopy: Record<SimulationExplainerErrorCode, { title: string; description: string }> = {
  empty_input: {
    title: "Input is required",
    description: "Paste a transaction envelope XDR or raw simulation JSON response to analyze."
  },
  invalid_input: {
    title: "Unrecognized simulation input",
    description: "The provided string could not be parsed as either base64 transaction XDR or JSON simulation result."
  },
  simulation_failed: {
    title: "Simulation execution failed",
    description: "The Soroban contract reverted or failed during RPC simulation."
  },
  rpc_error: {
    title: "Soroban RPC error",
    description: "The Soroban RPC node returned an error response or could not be reached."
  },
  parse_error: {
    title: "Failed to parse simulation result",
    description: "The response does not match the expected Soroban RPC simulateTransaction schema."
  }
};
