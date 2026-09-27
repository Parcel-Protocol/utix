import { xdr } from "@stellar/stellar-sdk";
import { ok, err, type Result } from "@/core/result/result";
import type {
  PredicateNode,
  PredicateType,
  PredicateAnalysis,
  ClaimablePredicateBuilderResult,
  ClaimablePredicateBuilderErrorCode
} from "@/features/claimable-predicate-builder/types";
import { ClaimablePredicateBuilderError } from "@/features/claimable-predicate-builder/lib/claimablePredicateBuilder.errors";

let idCounter = 0;
export function generateNodeId(): string {
  idCounter += 1;
  return `node_${Date.now()}_${idCounter}`;
}

export function createDefaultNode(type: PredicateType): PredicateNode {
  const id = generateNodeId();
  switch (type) {
    case "unconditional":
      return { id, type: "unconditional" };
    case "beforeAbsoluteTime": {
      const now = Math.floor(Date.now() / 1000) + 86400 * 7;
      return { id, type: "beforeAbsoluteTime", epochSeconds: now };
    }
    case "beforeRelativeTime":
      return { id, type: "beforeRelativeTime", relativeSeconds: 86400 * 30 };
    case "and":
      return {
        id,
        type: "and",
        left: { id: generateNodeId(), type: "unconditional" },
        right: {
          id: generateNodeId(),
          type: "beforeAbsoluteTime",
          epochSeconds: Math.floor(Date.now() / 1000) + 86400 * 30
        }
      };
    case "or":
      return {
        id,
        type: "or",
        left: { id: generateNodeId(), type: "unconditional" },
        right: {
          id: generateNodeId(),
          type: "beforeRelativeTime",
          relativeSeconds: 86400 * 14
        }
      };
    case "not":
      return {
        id,
        type: "not",
        inner: {
          id: generateNodeId(),
          type: "beforeAbsoluteTime",
          epochSeconds: Math.floor(Date.now() / 1000) + 86400
        }
      };
  }
}

export function formatDuration(seconds: number): string {
  if (seconds <= 0) return "0 seconds";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remSeconds = seconds % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days} day${days === 1 ? "" : "s"}`);
  if (hours > 0) parts.push(`${hours} hr${hours === 1 ? "" : "s"}`);
  if (minutes > 0) parts.push(`${minutes} min${minutes === 1 ? "" : "s"}`);
  if (remSeconds > 0 && parts.length === 0) parts.push(`${remSeconds} sec${remSeconds === 1 ? "" : "s"}`);

  return parts.join(" ") || `${seconds} seconds`;
}

export function formatTimestamp(epochSeconds: number): string {
  try {
    const d = new Date(epochSeconds * 1000);
    return d.toUTCString();
  } catch {
    return `${epochSeconds}s epoch`;
  }
}

export function explainPredicate(node: PredicateNode): string {
  switch (node.type) {
    case "unconditional":
      return "Can be claimed immediately at any time.";
    case "beforeAbsoluteTime": {
      const epoch = node.epochSeconds ?? 0;
      return `Can only be claimed before ${formatTimestamp(epoch)}.`;
    }
    case "beforeRelativeTime": {
      const rel = node.relativeSeconds ?? 0;
      return `Can only be claimed within ${formatDuration(rel)} after balance creation.`;
    }
    case "not": {
      if (!node.inner) return "Negation of unspecified condition.";
      if (node.inner.type === "unconditional") {
        return "Can NEVER be claimed (contradiction: negation of unconditional).";
      }
      if (node.inner.type === "beforeAbsoluteTime") {
        const epoch = node.inner.epochSeconds ?? 0;
        return `Can only be claimed on or after ${formatTimestamp(epoch)}.`;
      }
      if (node.inner.type === "beforeRelativeTime") {
        const rel = node.inner.relativeSeconds ?? 0;
        return `Can only be claimed at least ${formatDuration(rel)} after balance creation.`;
      }
      return `Must NOT satisfy: (${explainPredicate(node.inner)})`;
    }
    case "and": {
      const leftDesc = node.left ? explainPredicate(node.left) : "condition A";
      const rightDesc = node.right ? explainPredicate(node.right) : "condition B";
      return `Must satisfy BOTH: (${leftDesc}) AND (${rightDesc})`;
    }
    case "or": {
      const leftDesc = node.left ? explainPredicate(node.left) : "condition A";
      const rightDesc = node.right ? explainPredicate(node.right) : "condition B";
      return `Can be claimed if EITHER: (${leftDesc}) OR (${rightDesc})`;
    }
  }
}

export function analyzePredicate(node: PredicateNode, currentDepth = 0): PredicateAnalysis {
  let isSatisfiable = true;
  let warning: string | undefined;
  let maxChildDepth = currentDepth;
  let nodeCount = 1;

  if (node.type === "not" && node.inner) {
    if (node.inner.type === "unconditional") {
      isSatisfiable = false;
      warning = "Contradiction: NOT(unconditional) evaluates to FALSE. This balance can never be claimed.";
    }
    const innerAnalysis = analyzePredicate(node.inner, currentDepth + 1);
    maxChildDepth = Math.max(maxChildDepth, innerAnalysis.depth);
    nodeCount += innerAnalysis.nodeCount;
    if (!innerAnalysis.isSatisfiable) {
      // not(unsatisfiable) becomes satisfiable
    }
  } else if (node.type === "and" && node.left && node.right) {
    const leftRes = analyzePredicate(node.left, currentDepth + 1);
    const rightRes = analyzePredicate(node.right, currentDepth + 1);
    maxChildDepth = Math.max(maxChildDepth, leftRes.depth, rightRes.depth);
    nodeCount += leftRes.nodeCount + rightRes.nodeCount;

    if (!leftRes.isSatisfiable || !rightRes.isSatisfiable) {
      isSatisfiable = false;
      warning = leftRes.warning ?? rightRes.warning ?? "One of the AND branches is unsatisfiable.";
    }

    // Check for contradictory absolute time range: AND(before(T1), NOT(before(T2))) where T1 <= T2
    let absBefore: number | null = null;
    let absAfter: number | null = null;

    if (node.left.type === "beforeAbsoluteTime") absBefore = node.left.epochSeconds ?? null;
    if (node.right.type === "beforeAbsoluteTime") absBefore = node.right.epochSeconds ?? null;
    if (node.left.type === "not" && node.left.inner?.type === "beforeAbsoluteTime") {
      absAfter = node.left.inner.epochSeconds ?? null;
    }
    if (node.right.type === "not" && node.right.inner?.type === "beforeAbsoluteTime") {
      absAfter = node.right.inner.epochSeconds ?? null;
    }

    if (absBefore !== null && absAfter !== null && absBefore <= absAfter) {
      isSatisfiable = false;
      warning = `Contradiction: Required window before ${formatTimestamp(absBefore)} and after ${formatTimestamp(absAfter)} is impossible.`;
    }

    // Check for contradictory relative time range
    let relBefore: number | null = null;
    let relAfter: number | null = null;
    if (node.left.type === "beforeRelativeTime") relBefore = node.left.relativeSeconds ?? null;
    if (node.right.type === "beforeRelativeTime") relBefore = node.right.relativeSeconds ?? null;
    if (node.left.type === "not" && node.left.inner?.type === "beforeRelativeTime") {
      relAfter = node.left.inner.relativeSeconds ?? null;
    }
    if (node.right.type === "not" && node.right.inner?.type === "beforeRelativeTime") {
      relAfter = node.right.inner.relativeSeconds ?? null;
    }

    if (relBefore !== null && relAfter !== null && relBefore <= relAfter) {
      isSatisfiable = false;
      warning = `Contradiction: Relative window before ${relBefore}s and after ${relAfter}s is empty.`;
    }
  } else if (node.type === "or" && node.left && node.right) {
    const leftRes = analyzePredicate(node.left, currentDepth + 1);
    const rightRes = analyzePredicate(node.right, currentDepth + 1);
    maxChildDepth = Math.max(maxChildDepth, leftRes.depth, rightRes.depth);
    nodeCount += leftRes.nodeCount + rightRes.nodeCount;

    if (!leftRes.isSatisfiable && !rightRes.isSatisfiable) {
      isSatisfiable = false;
      warning = "Both OR branches are unsatisfiable.";
    }
  }

  if (maxChildDepth > 4 && !warning) {
    warning = "Stellar protocol enforces a maximum predicate tree depth of 4. This predicate may be rejected by the network.";
  }

  return {
    isSatisfiable,
    depth: maxChildDepth,
    nodeCount,
    warning
  };
}

export function astToXdr(node: PredicateNode, depth = 0): xdr.ClaimPredicate {
  if (depth > 10) {
    throw new ClaimablePredicateBuilderError("max_depth_exceeded", "Maximum predicate recursion depth exceeded.");
  }

  switch (node.type) {
    case "unconditional":
      return xdr.ClaimPredicate.claimPredicateUnconditional();

    case "beforeAbsoluteTime": {
      const sec = Math.floor(node.epochSeconds ?? 0);
      return xdr.ClaimPredicate.claimPredicateBeforeAbsoluteTime(xdr.Int64.fromString(String(sec)));
    }

    case "beforeRelativeTime": {
      const sec = Math.floor(node.relativeSeconds ?? 0);
      return xdr.ClaimPredicate.claimPredicateBeforeRelativeTime(xdr.Int64.fromString(String(sec)));
    }

    case "not": {
      const inner = node.inner ? astToXdr(node.inner, depth + 1) : xdr.ClaimPredicate.claimPredicateUnconditional();
      return xdr.ClaimPredicate.claimPredicateNot(inner);
    }

    case "and": {
      const left = node.left ? astToXdr(node.left, depth + 1) : xdr.ClaimPredicate.claimPredicateUnconditional();
      const right = node.right ? astToXdr(node.right, depth + 1) : xdr.ClaimPredicate.claimPredicateUnconditional();
      return xdr.ClaimPredicate.claimPredicateAnd([left, right]);
    }

    case "or": {
      const left = node.left ? astToXdr(node.left, depth + 1) : xdr.ClaimPredicate.claimPredicateUnconditional();
      const right = node.right ? astToXdr(node.right, depth + 1) : xdr.ClaimPredicate.claimPredicateUnconditional();
      return xdr.ClaimPredicate.claimPredicateOr([left, right]);
    }
  }
}

export function astToBase64(node: PredicateNode): string {
  const predicate = astToXdr(node);
  return predicate.toXDR("base64");
}

export function xdrToAst(predicate: xdr.ClaimPredicate, depth = 0): PredicateNode {
  if (depth > 10) {
    throw new ClaimablePredicateBuilderError("max_depth_exceeded", "Maximum predicate recursion depth exceeded while parsing XDR.");
  }

  const id = generateNodeId();
  const switchName = predicate.switch().name;

  switch (switchName) {
    case "claimPredicateUnconditional":
      return { id, type: "unconditional" };

    case "claimPredicateBeforeAbsoluteTime": {
      const sec = Number(predicate.absBefore().toString());
      return { id, type: "beforeAbsoluteTime", epochSeconds: sec };
    }

    case "claimPredicateBeforeRelativeTime": {
      const sec = Number(predicate.relBefore().toString());
      return { id, type: "beforeRelativeTime", relativeSeconds: sec };
    }

    case "claimPredicateNot": {
      const innerPredicate = predicate.notPredicate();
      return {
        id,
        type: "not",
        inner: innerPredicate ? xdrToAst(innerPredicate, depth + 1) : { id: generateNodeId(), type: "unconditional" }
      };
    }

    case "claimPredicateAnd": {
      const arms = predicate.andPredicates();
      return {
        id,
        type: "and",
        left: arms[0] ? xdrToAst(arms[0], depth + 1) : { id: generateNodeId(), type: "unconditional" },
        right: arms[1] ? xdrToAst(arms[1], depth + 1) : { id: generateNodeId(), type: "unconditional" }
      };
    }

    case "claimPredicateOr": {
      const arms = predicate.orPredicates();
      return {
        id,
        type: "or",
        left: arms[0] ? xdrToAst(arms[0], depth + 1) : { id: generateNodeId(), type: "unconditional" },
        right: arms[1] ? xdrToAst(arms[1], depth + 1) : { id: generateNodeId(), type: "unconditional" }
      };
    }

    default:
      throw new ClaimablePredicateBuilderError("invalid_xdr", `Unknown predicate variant: ${switchName}`);
  }
}

export function base64ToAst(base64: string): PredicateNode {
  const trimmed = base64.trim();
  if (!trimmed) {
    throw new ClaimablePredicateBuilderError("empty_input", "Predicate XDR input is empty.");
  }

  try {
    const decoded = xdr.ClaimPredicate.fromXDR(trimmed, "base64");
    return xdrToAst(decoded);
  } catch (err: unknown) {
    if (err instanceof ClaimablePredicateBuilderError) throw err;
    throw new ClaimablePredicateBuilderError("invalid_xdr", "Provided string is not valid base64-encoded ClaimPredicate XDR.");
  }
}

export function buildPredicateResult(node: PredicateNode): ClaimablePredicateBuilderResult {
  const plainLanguage = explainPredicate(node);
  const base64Xdr = astToBase64(node);
  const analysis = analyzePredicate(node);

  return {
    root: node,
    plainLanguage,
    base64Xdr,
    analysis
  };
}

export function getTemplateNode(
  template: "unconditional" | "timelock" | "window" | "grace"
): PredicateNode {
  const now = Math.floor(Date.now() / 1000);
  switch (template) {
    case "unconditional":
      return { id: generateNodeId(), type: "unconditional" };
    case "timelock":
      return {
        id: generateNodeId(),
        type: "not",
        inner: {
          id: generateNodeId(),
          type: "beforeAbsoluteTime",
          epochSeconds: now + 86400 * 7
        }
      };
    case "window":
      return {
        id: generateNodeId(),
        type: "and",
        left: {
          id: generateNodeId(),
          type: "not",
          inner: {
            id: generateNodeId(),
            type: "beforeAbsoluteTime",
            epochSeconds: now + 86400 * 2
          }
        },
        right: {
          id: generateNodeId(),
          type: "beforeAbsoluteTime",
          epochSeconds: now + 86400 * 14
        }
      };
    case "grace":
      return {
        id: generateNodeId(),
        type: "beforeRelativeTime",
        relativeSeconds: 86400 * 30
      };
  }
}

export async function runClaimablePredicateBuilder(
  input: { value: string },
  _network?: unknown,
  _signal?: AbortSignal
): Promise<Result<ClaimablePredicateBuilderResult, ClaimablePredicateBuilderErrorCode>> {
  try {
    const trimmed = input.value.trim();
    if (!trimmed) {
      return err("empty_input");
    }

    const node = base64ToAst(trimmed);
    const result = buildPredicateResult(node);
    return ok(result);
  } catch (error: unknown) {
    if (error instanceof ClaimablePredicateBuilderError) {
      return err(error.code);
    }
    return err("invalid_xdr");
  }
}
