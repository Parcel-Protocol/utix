import { describe, it, expect } from "vitest";
import {
  createDefaultNode,
  astToXdr,
  astToBase64,
  xdrToAst,
  base64ToAst,
  explainPredicate,
  analyzePredicate,
  getTemplateNode,
  buildPredicateResult
} from "@/features/claimable-predicate-builder/lib/claimablePredicateBuilder";
import type { PredicateNode } from "@/features/claimable-predicate-builder/types";

describe("claimablePredicateBuilder lib", () => {
  describe("AST to XDR and roundtrip", () => {
    it("roundtrips unconditional predicate", () => {
      const node = createDefaultNode("unconditional");
      const b64 = astToBase64(node);
      const decoded = base64ToAst(b64);

      expect(decoded.type).toBe("unconditional");
    });

    it("roundtrips beforeAbsoluteTime predicate", () => {
      const node: PredicateNode = {
        id: "abs",
        type: "beforeAbsoluteTime",
        epochSeconds: 1700000000
      };
      const b64 = astToBase64(node);
      const decoded = base64ToAst(b64);

      expect(decoded.type).toBe("beforeAbsoluteTime");
      expect(decoded.epochSeconds).toBe(1700000000);
    });

    it("roundtrips beforeRelativeTime predicate", () => {
      const node: PredicateNode = {
        id: "rel",
        type: "beforeRelativeTime",
        relativeSeconds: 86400
      };
      const b64 = astToBase64(node);
      const decoded = base64ToAst(b64);

      expect(decoded.type).toBe("beforeRelativeTime");
      expect(decoded.relativeSeconds).toBe(86400);
    });

    it("roundtrips not(beforeAbsoluteTime) predicate (timelock)", () => {
      const node: PredicateNode = {
        id: "not-node",
        type: "not",
        inner: {
          id: "inner-node",
          type: "beforeAbsoluteTime",
          epochSeconds: 1800000000
        }
      };
      const b64 = astToBase64(node);
      const decoded = base64ToAst(b64);

      expect(decoded.type).toBe("not");
      expect(decoded.inner?.type).toBe("beforeAbsoluteTime");
      expect(decoded.inner?.epochSeconds).toBe(1800000000);
    });

    it("roundtrips composite and(or, not) tree", () => {
      const node: PredicateNode = {
        id: "and-root",
        type: "and",
        left: {
          id: "or-child",
          type: "or",
          left: { id: "p1", type: "unconditional" },
          right: { id: "p2", type: "beforeRelativeTime", relativeSeconds: 3600 }
        },
        right: {
          id: "not-child",
          type: "not",
          inner: { id: "p3", type: "beforeAbsoluteTime", epochSeconds: 1750000000 }
        }
      };

      const b64 = astToBase64(node);
      const decoded = base64ToAst(b64);

      expect(decoded.type).toBe("and");
      expect(decoded.left?.type).toBe("or");
      expect(decoded.right?.type).toBe("not");
    });

    it("throws invalid_xdr on malformed base64 input", () => {
      expect(() => base64ToAst("not-valid-xdr-at-all!!")).toThrow();
    });

    it("throws empty_input when empty string provided", () => {
      expect(() => base64ToAst("   ")).toThrow();
    });
  });

  describe("Plain language explanation", () => {
    it("explains unconditional", () => {
      const node = createDefaultNode("unconditional");
      expect(explainPredicate(node)).toContain("immediately at any time");
    });

    it("explains absolute time lock and deadline", () => {
      const deadline: PredicateNode = {
        id: "1",
        type: "beforeAbsoluteTime",
        epochSeconds: 1700000000
      };
      expect(explainPredicate(deadline)).toContain("Can only be claimed before");

      const timelock: PredicateNode = {
        id: "2",
        type: "not",
        inner: deadline
      };
      expect(explainPredicate(timelock)).toContain("Can only be claimed on or after");
    });

    it("explains relative duration", () => {
      const node: PredicateNode = {
        id: "rel",
        type: "beforeRelativeTime",
        relativeSeconds: 86400 * 3
      };
      expect(explainPredicate(node)).toContain("within 3 days after balance creation");

      const notRel: PredicateNode = {
        id: "notRel",
        type: "not",
        inner: node
      };
      expect(explainPredicate(notRel)).toContain("at least 3 days after balance creation");
    });

    it("explains contradiction on NOT(unconditional)", () => {
      const node: PredicateNode = {
        id: "bad",
        type: "not",
        inner: { id: "unc", type: "unconditional" }
      };
      expect(explainPredicate(node)).toContain("Can NEVER be claimed");
    });

    it("explains composite and/or", () => {
      const andNode: PredicateNode = {
        id: "and",
        type: "and",
        left: { id: "1", type: "unconditional" },
        right: { id: "2", type: "beforeRelativeTime", relativeSeconds: 60 }
      };
      expect(explainPredicate(andNode)).toContain("Must satisfy BOTH:");

      const orNode: PredicateNode = {
        id: "or",
        type: "or",
        left: { id: "1", type: "unconditional" },
        right: { id: "2", type: "beforeRelativeTime", relativeSeconds: 60 }
      };
      expect(explainPredicate(orNode)).toContain("Can be claimed if EITHER:");
    });
  });

  describe("Unsatisfiability & analysis", () => {
    it("flags not(unconditional) as unsatisfiable", () => {
      const node: PredicateNode = {
        id: "1",
        type: "not",
        inner: { id: "2", type: "unconditional" }
      };
      const analysis = analyzePredicate(node);
      expect(analysis.isSatisfiable).toBe(false);
      expect(analysis.warning).toContain("Contradiction");
    });

    it("flags contradictory absolute time window as unsatisfiable", () => {
      // Must be claimed before epoch 1000 AND after epoch 2000 -> impossible!
      const node: PredicateNode = {
        id: "window",
        type: "and",
        left: { id: "before", type: "beforeAbsoluteTime", epochSeconds: 1000 },
        right: {
          id: "after",
          type: "not",
          inner: { id: "inner", type: "beforeAbsoluteTime", epochSeconds: 2000 }
        }
      };

      const analysis = analyzePredicate(node);
      expect(analysis.isSatisfiable).toBe(false);
      expect(analysis.warning).toContain("impossible");
    });

    it("flags contradictory relative window as unsatisfiable", () => {
      const node: PredicateNode = {
        id: "window",
        type: "and",
        left: { id: "before", type: "beforeRelativeTime", relativeSeconds: 100 },
        right: {
          id: "after",
          type: "not",
          inner: { id: "inner", type: "beforeRelativeTime", relativeSeconds: 500 }
        }
      };

      const analysis = analyzePredicate(node);
      expect(analysis.isSatisfiable).toBe(false);
      expect(analysis.warning).toContain("empty");
    });

    it("calculates correct tree depth and node count", () => {
      const node = getTemplateNode("window");
      const analysis = analyzePredicate(node);
      expect(analysis.depth).toBeGreaterThanOrEqual(2);
      expect(analysis.nodeCount).toBeGreaterThanOrEqual(3);
      expect(analysis.isSatisfiable).toBe(true);
    });
  });

  describe("buildPredicateResult", () => {
    it("builds complete result object from AST", () => {
      const node = getTemplateNode("timelock");
      const result = buildPredicateResult(node);

      expect(result.plainLanguage).toBeDefined();
      expect(result.base64Xdr).toBeDefined();
      expect(result.analysis.isSatisfiable).toBe(true);
    });
  });
});
