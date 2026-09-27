"use client";

import { useMemo, useState } from "react";

export interface AccessibleTreeNode {
  id: string;
  label: string;
  value?: string;
  children?: AccessibleTreeNode[];
}

/**
 * Upper bound for tree nesting accepted by {@link validateAccessibleTreeNodes}.
 *
 * The traversal helpers below are recursive, so pathological nesting could
 * exhaust the call stack. Anything deeper than this is rejected up front and
 * rendered as an accessible error instead of crashing the page.
 */
export const MAX_ACCESSIBLE_TREE_DEPTH = 32;

export type AccessibleTreeValidationIssueCode =
  | "empty-id"
  | "duplicate-id"
  | "invalid-children"
  | "max-depth-exceeded";

export interface AccessibleTreeValidationIssue {
  code: AccessibleTreeValidationIssueCode;
  /** Human-readable explanation. Never echoes labels or values. */
  message: string;
  /** Offending node id, when the issue is attributable to one node. */
  nodeId?: string;
}

export type AccessibleTreeValidation =
  | { ok: true }
  | { ok: false; issues: AccessibleTreeValidationIssue[] };

const EMPTY_NODES: AccessibleTreeNode[] = [];

/**
 * Validates tree data before it reaches the accessibility tree.
 *
 * Runs iteratively (cycle-safe: a repeated id is reported, never descended
 * into) and checks every node for a non-empty unique string id, array-shaped
 * children, and a nesting depth within {@link MAX_ACCESSIBLE_TREE_DEPTH}.
 */
export function validateAccessibleTreeNodes(nodes: AccessibleTreeNode[]): AccessibleTreeValidation {
  const issues: AccessibleTreeValidationIssue[] = [];
  if (!Array.isArray(nodes)) {
    return {
      ok: false,
      issues: [{ code: "invalid-children", message: "AccessibleTree requires nodes to be an array." }]
    };
  }
  const seen = new Set<string>();
  const stack: Array<{ siblings: AccessibleTreeNode[]; depth: number }> = [{ siblings: nodes, depth: 1 }];
  while (stack.length > 0) {
    const { siblings, depth } = stack.pop() as { siblings: AccessibleTreeNode[]; depth: number };
    if (!Array.isArray(siblings)) {
      issues.push({ code: "invalid-children", message: "AccessibleTree node children must be an array." });
      continue;
    }
    if (depth > MAX_ACCESSIBLE_TREE_DEPTH) {
      issues.push({
        code: "max-depth-exceeded",
        message: `AccessibleTree nesting exceeds the maximum depth of ${MAX_ACCESSIBLE_TREE_DEPTH}.`
      });
      continue;
    }
    for (const node of siblings) {
      if (!node || typeof node.id !== "string" || node.id.length === 0) {
        issues.push({
          code: "empty-id",
          message: "Every AccessibleTree node must have a non-empty string id."
        });
        continue;
      }
      if (seen.has(node.id)) {
        issues.push({
          code: "duplicate-id",
          message: `Duplicate AccessibleTree node id "${node.id}". Node ids must be unique so focus and aria references resolve to one element.`,
          nodeId: node.id
        });
        continue;
      }
      seen.add(node.id);
      if (node.children !== undefined) {
        if (!Array.isArray(node.children)) {
          issues.push({
            code: "invalid-children",
            message: `Children of AccessibleTree node "${node.id}" must be an array.`,
            nodeId: node.id
          });
        } else if (node.children.length > 0) {
          stack.push({ siblings: node.children, depth: depth + 1 });
        }
      }
    }
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true };
}

/**
 * Reusable WAI-ARIA tree primitive (`role="tree"`).
 *
 * Keyboard model (follows the ARIA treeview pattern):
 *
 * | Key | Behaviour |
 * |---|---|
 * | `ArrowDown` / `ArrowUp` | Move focus to the next / previous *visible* node. |
 * | `Home` / `End` | Move focus to the first / last visible node. |
 * | `ArrowRight` | Expand a collapsed branch, or move focus to its first child. |
 * | `ArrowLeft` | Collapse an expanded branch, or move focus to its parent. |
 * | `Enter` / `Space` | Toggle expansion of the focused branch. |
 *
 * ARIA contract: every item uses `role="treeitem"` with `aria-level`,
 * `aria-setsize`, `aria-posinset` and single-select `aria-selected` that
 * follows focus (roving `tabIndex`, so exactly one item is tabbable).
 * Branches additionally expose `aria-expanded`; child sets are wrapped in
 * `role="group"`. Collapsed descendants are not rendered, so assistive
 * technology never encounters them.
 *
 * Malformed data (missing, duplicate or non-string ids, non-array children,
 * nesting deeper than {@link MAX_ACCESSIBLE_TREE_DEPTH}) is never rendered
 * as a broken tree: the component renders a `role="alert"` summary instead.
 * Validation messages reference node ids only — labels and values are never
 * echoed, and secret keys must never be passed as node data (see SECURITY.md).
 */
export function AccessibleTree({ label, nodes }: { label: string; nodes: AccessibleTreeNode[] }) {
  const validation = useMemo(() => validateAccessibleTreeNodes(nodes), [nodes]);
  const safeNodes = validation.ok ? nodes : EMPTY_NODES;
  const branches = useMemo(
    () => new Set(flatten(safeNodes).filter((node) => node.children?.length).map((node) => node.id)),
    [safeNodes]
  );
  const [expanded, setExpanded] = useState(branches);
  const [active, setActive] = useState(safeNodes[0]?.id ?? "");
  const visible = useMemo(() => flattenVisible(safeNodes, expanded), [safeNodes, expanded]);
  const parents = useMemo(() => buildParentMap(safeNodes), [safeNodes]);

  function focus(id: string) {
    setActive(id);
    requestAnimationFrame(() => document.getElementById(id)?.focus());
  }

  function toggleExpand(id: string) {
    setExpanded(expanded.has(id) ? new Set([...expanded].filter((entry) => entry !== id)) : new Set(expanded).add(id));
  }

  if (!validation.ok) {
    return (
      <div role="alert" className="space-y-1 text-xs">
        <p className="font-medium">This navigation tree could not be displayed because its data is invalid.</p>
        <ul className="list-disc pl-4 text-muted-foreground">
          {validation.issues.map((issue, index) => (
            <li key={`${issue.code}-${issue.nodeId ?? "tree"}-${index}`}>{issue.message}</li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div role="tree" aria-label={label} className="space-y-1 text-xs">
      {safeNodes.map((node, index) => (
        <TreeItem
          key={node.id}
          node={node}
          level={1}
          setsize={safeNodes.length}
          posinset={index + 1}
          expanded={expanded}
          active={active}
          setActive={setActive}
          setExpanded={setExpanded}
          onNavigate={(event, current) => {
            if (visible.length === 0) return;
            const found = visible.findIndex((item) => item.id === current.id);
            const at = found === -1 ? 0 : found;
            if (event.key === "ArrowDown") focus(visible[Math.min(at + 1, visible.length - 1)].id);
            else if (event.key === "ArrowUp") focus(visible[Math.max(at - 1, 0)].id);
            else if (event.key === "Home") focus(visible[0].id);
            else if (event.key === "End") focus(visible[visible.length - 1].id);
            else if (event.key === "ArrowRight" && current.children?.length) {
              if (!expanded.has(current.id)) setExpanded(new Set(expanded).add(current.id));
              else focus(current.children[0].id);
            } else if (event.key === "ArrowLeft") {
              if (current.children?.length && expanded.has(current.id)) {
                setExpanded(new Set([...expanded].filter((id) => id !== current.id)));
              } else {
                const parentId = parents.get(current.id);
                if (!parentId) return;
                focus(parentId);
              }
            } else if ((event.key === "Enter" || event.key === " ") && current.children?.length) {
              toggleExpand(current.id);
            } else return;
            event.preventDefault();
          }}
        />
      ))}
    </div>
  );
}

function TreeItem({ node, level, setsize, posinset, expanded, active, setActive, setExpanded, onNavigate }: {
  node: AccessibleTreeNode;
  level: number;
  setsize: number;
  posinset: number;
  expanded: Set<string>;
  active: string;
  setActive: (id: string) => void;
  setExpanded: (value: Set<string>) => void;
  onNavigate: (event: React.KeyboardEvent, node: AccessibleTreeNode) => void;
}) {
  const branch = Boolean(node.children?.length);
  const open = branch && expanded.has(node.id);
  const toggle = () => branch && setExpanded(open
    ? new Set([...expanded].filter((id) => id !== node.id))
    : new Set(expanded).add(node.id));

  return (
    <div>
      <div
        id={node.id}
        role="treeitem"
        aria-selected={active === node.id}
        aria-level={level}
        aria-setsize={setsize}
        aria-posinset={posinset}
        aria-expanded={branch ? open : undefined}
        tabIndex={active === node.id ? 0 : -1}
        onFocus={() => setActive(node.id)}
        onKeyDown={(event) => onNavigate(event, node)}
        className="rounded px-2 py-1 outline-none focus:ring-2 focus:ring-ring"
      >
        {branch ? <button type="button" tabIndex={-1} aria-label={`${open ? "Collapse" : "Expand"} ${node.label}`} className="mr-1 w-4" onClick={toggle}>{open ? "−" : "+"}</button> : <span className="mr-1 inline-block w-4" />}
        <span className="text-muted-foreground">{node.label}</span>
        {node.value === undefined ? null : <>: <span className="font-mono">{node.value}</span></>}
      </div>
      {open ? (
        <div role="group" className="ml-4">
          {node.children!.map((child, index) => <TreeItem key={child.id} node={child} level={level + 1} setsize={node.children!.length} posinset={index + 1} expanded={expanded} active={active} setActive={setActive} setExpanded={setExpanded} onNavigate={onNavigate} />)}
        </div>
      ) : null}
    </div>
  );
}

function flatten(nodes: AccessibleTreeNode[]): AccessibleTreeNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children ?? [])]);
}

function flattenVisible(nodes: AccessibleTreeNode[], expanded: Set<string>): AccessibleTreeNode[] {
  return nodes.flatMap((node) => [node, ...(expanded.has(node.id) ? flattenVisible(node.children ?? [], expanded) : [])]);
}

function buildParentMap(nodes: AccessibleTreeNode[]): Map<string, string> {
  const parents = new Map<string, string>();
  const stack: AccessibleTreeNode[] = [...nodes];
  while (stack.length > 0) {
    const node = stack.pop() as AccessibleTreeNode;
    for (const child of node.children ?? []) {
      if (!parents.has(child.id)) parents.set(child.id, node.id);
      stack.push(child);
    }
  }
  return parents;
}
