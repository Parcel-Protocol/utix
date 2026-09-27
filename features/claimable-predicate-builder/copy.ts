import type { ClaimablePredicateBuilderErrorCode } from "@/features/claimable-predicate-builder/types";

export const copy = {
  formLabel: "Import Predicate XDR (Optional)",
  formHint: "Paste an existing base64-encoded ClaimPredicate XDR to inspect, or use the builder below.",
  submit: "Build & Encode Predicate",
  emptyTitle: "Construct or Import a Predicate",
  emptyDescription: "Assemble claim conditions as a logical tree, verify plain English interpretation, and copy the resulting XDR.",
  resultTitle: "Generated Predicate Specification",
  plainLanguageTitle: "Plain Language Interpretation",
  xdrTitle: "Base64 ClaimPredicate XDR",
  copyXdr: "Copy XDR",
  copied: "Copied!",
  templateUnconditional: "Immediate (Unconditional)",
  templateTimelock: "Timelock (Claim After Date)",
  templateWindow: "Time Window (Between Dates)",
  templateGrace: "Grace Period (30 Days)",
  treeHeading: "Interactive Predicate Tree",
  satisfiable: "Logically Satisfiable",
  unsatisfiable: "Contradiction / Unsatisfiable",
  depthNotice: "Tree Depth",
  nodeCountNotice: "Total Conditions"
} as const;

export const errorCopy: Record<ClaimablePredicateBuilderErrorCode, { title: string; description: string }> = {
  empty_input: {
    title: "Enter a valid value",
    description: "Provide a valid predicate node structure or paste base64 XDR."
  },
  invalid_input: {
    title: "Invalid predicate configuration",
    description: "The specified time offset or timestamp is invalid."
  },
  invalid_xdr: {
    title: "Invalid ClaimPredicate XDR",
    description: "The provided string could not be decoded as a valid Stellar ClaimPredicate."
  },
  unsatisfiable_predicate: {
    title: "Unsatisfiable predicate",
    description: "The predicate contains contradictory conditions that can never be met."
  },
  max_depth_exceeded: {
    title: "Maximum tree depth exceeded",
    description: "The predicate exceeds allowable tree recursion depth."
  }
};
