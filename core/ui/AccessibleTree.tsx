"use client";

import { useMemo, useState } from "react";

export interface AccessibleTreeNode {
  id: string;
  label: string;
  value?: string;
  children?: AccessibleTreeNode[];
}

export function AccessibleTree({ label, nodes }: { label: string; nodes: AccessibleTreeNode[] }) {
  const branches = useMemo(
    () => new Set(flatten(nodes).filter((node) => node.children?.length).map((node) => node.id)),
    [nodes]
  );
  const [expanded, setExpanded] = useState(branches);
  const [active, setActive] = useState(nodes[0]?.id ?? "");
  const visible = flattenVisible(nodes, expanded);

  function focus(id: string) {
    setActive(id);
    requestAnimationFrame(() => document.getElementById(id)?.focus());
  }

  return (
    <div role="tree" aria-label={label} className="space-y-1 text-xs">
      {nodes.map((node) => (
        <TreeItem
          key={node.id}
          node={node}
          level={1}
          expanded={expanded}
          active={active}
          setActive={setActive}
          setExpanded={setExpanded}
          onNavigate={(event, current) => {
            const index = visible.findIndex((item) => item.id === current.id);
            if (event.key === "ArrowDown") focus(visible[Math.min(index + 1, visible.length - 1)].id);
            else if (event.key === "ArrowUp") focus(visible[Math.max(index - 1, 0)].id);
            else if (event.key === "Home") focus(visible[0].id);
            else if (event.key === "End") focus(visible[visible.length - 1].id);
            else if (event.key === "ArrowRight" && current.children?.length) {
              if (!expanded.has(current.id)) setExpanded(new Set(expanded).add(current.id));
              else focus(current.children[0].id);
            } else if (event.key === "ArrowLeft" && expanded.has(current.id)) {
              setExpanded(new Set([...expanded].filter((id) => id !== current.id)));
            } else return;
            event.preventDefault();
          }}
        />
      ))}
    </div>
  );
}

function TreeItem({ node, level, expanded, active, setActive, setExpanded, onNavigate }: {
  node: AccessibleTreeNode;
  level: number;
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
          {node.children!.map((child) => <TreeItem key={child.id} node={child} level={level + 1} expanded={expanded} active={active} setActive={setActive} setExpanded={setExpanded} onNavigate={onNavigate} />)}
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
