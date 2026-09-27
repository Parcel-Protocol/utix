export type PredicateType =
  | "unconditional"
  | "beforeAbsoluteTime"
  | "beforeRelativeTime"
  | "and"
  | "or"
  | "not";

export interface PredicateNode {
  id: string;
  type: PredicateType;
  epochSeconds?: number;
  relativeSeconds?: number;
  left?: PredicateNode;
  right?: PredicateNode;
  inner?: PredicateNode;
}

export interface PredicateAnalysis {
  isSatisfiable: boolean;
  depth: number;
  nodeCount: number;
  warning?: string;
}

export interface ClaimablePredicateBuilderInput {
  value: string;
}

export interface ClaimablePredicateBuilderResult {
  root: PredicateNode;
  plainLanguage: string;
  base64Xdr: string;
  analysis: PredicateAnalysis;
}

export type ClaimablePredicateBuilderErrorCode =
  | "empty_input"
  | "invalid_input"
  | "invalid_xdr"
  | "unsatisfiable_predicate"
  | "max_depth_exceeded";
