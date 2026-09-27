import type { ClaimablePredicateBuilderResult } from "@/features/claimable-predicate-builder/types";

export const claimablePredicateBuilderFixture: ClaimablePredicateBuilderResult = {
  root: {
    id: "fixture_root",
    type: "unconditional"
  },
  plainLanguage: "Can be claimed immediately at any time.",
  base64Xdr: "AAAAAA==",
  analysis: {
    isSatisfiable: true,
    depth: 0,
    nodeCount: 1
  }
};
