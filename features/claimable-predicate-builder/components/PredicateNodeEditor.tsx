"use client";

import React from "react";
import type { PredicateNode, PredicateType } from "@/features/claimable-predicate-builder/types";
import {
  createDefaultNode,
  formatDuration,
  formatTimestamp
} from "@/features/claimable-predicate-builder/lib/claimablePredicateBuilder";

export function PredicateNodeEditor({
  node,
  onChange,
  depth = 0
}: {
  node: PredicateNode;
  onChange: (updated: PredicateNode) => void;
  depth?: number;
}) {
  function handleTypeChange(newType: PredicateType) {
    if (newType === node.type) return;
    const fresh = createDefaultNode(newType);
    onChange({ ...fresh, id: node.id });
  }

  function handleEpochChange(epoch: number) {
    onChange({ ...node, epochSeconds: epoch });
  }

  function handleRelativeChange(seconds: number) {
    onChange({ ...node, relativeSeconds: Math.max(0, seconds) });
  }

  return (
    <div
      role="group"
      aria-label={`Predicate condition: ${node.type}`}
      className="p-3 border border-[#E2E8F0] dark:border-[#2D3748] rounded-md bg-[#F8FAFC] dark:bg-[#1A202C] space-y-3"
      style={{ marginLeft: `${Math.min(depth, 3) * 12}px` }}
    >
      <div className="flex flex-wrap items-center gap-3">
        <label
          htmlFor={`type-select-${node.id}`}
          className="text-xs font-semibold uppercase tracking-wider text-[#4A5568] dark:text-[#A0AEC0]"
        >
          Condition Type
        </label>
        <select
          id={`type-select-${node.id}`}
          value={node.type}
          onChange={(e) => handleTypeChange(e.target.value as PredicateType)}
          className="px-2 py-1 text-sm border border-[#CBD5E0] dark:border-[#4A5568] rounded bg-white dark:bg-[#2D3748] text-[#1A202C] dark:text-white"
        >
          <option value="unconditional">Unconditional (Claimable Always)</option>
          <option value="beforeAbsoluteTime">Before Absolute Time (Date & Time)</option>
          <option value="beforeRelativeTime">Before Relative Time (Duration)</option>
          <option value="and">AND (Both Must Be True)</option>
          <option value="or">OR (Either Can Be True)</option>
          <option value="not">NOT (Invert Condition)</option>
        </select>
      </div>

      {node.type === "beforeAbsoluteTime" ? (
        <div className="flex flex-wrap items-center gap-3 pt-1">
          <label
            htmlFor={`epoch-input-${node.id}`}
            className="text-xs font-medium text-[#4A5568] dark:text-[#A0AEC0]"
          >
            Claimable Before (Epoch Seconds):
          </label>
          <input
            id={`epoch-input-${node.id}`}
            type="number"
            value={node.epochSeconds ?? 0}
            onChange={(e) => handleEpochChange(Number(e.target.value))}
            className="w-48 px-2 py-1 text-sm border border-[#CBD5E0] dark:border-[#4A5568] rounded bg-white dark:bg-[#2D3748] text-[#1A202C] dark:text-white font-mono"
          />
          <span className="text-xs text-[#718096]">
            {formatTimestamp(node.epochSeconds ?? 0)}
          </span>
        </div>
      ) : null}

      {node.type === "beforeRelativeTime" ? (
        <div className="flex flex-wrap items-center gap-3 pt-1">
          <label
            htmlFor={`rel-input-${node.id}`}
            className="text-xs font-medium text-[#4A5568] dark:text-[#A0AEC0]"
          >
            Duration After Creation (Seconds):
          </label>
          <input
            id={`rel-input-${node.id}`}
            type="number"
            value={node.relativeSeconds ?? 0}
            onChange={(e) => handleRelativeChange(Number(e.target.value))}
            className="w-40 px-2 py-1 text-sm border border-[#CBD5E0] dark:border-[#4A5568] rounded bg-white dark:bg-[#2D3748] text-[#1A202C] dark:text-white font-mono"
          />
          <span className="text-xs text-[#718096]">
            {formatDuration(node.relativeSeconds ?? 0)}
          </span>
        </div>
      ) : null}

      {node.type === "not" && node.inner ? (
        <div className="pt-2 pl-2 border-l-2 border-[#CBD5E0] dark:border-[#4A5568]">
          <span className="text-xs font-semibold text-[#4A5568] dark:text-[#A0AEC0] block mb-2">
            Inverted Inner Condition:
          </span>
          <PredicateNodeEditor
            node={node.inner}
            onChange={(updated) => onChange({ ...node, inner: updated })}
            depth={depth + 1}
          />
        </div>
      ) : null}

      {(node.type === "and" || node.type === "or") && node.left && node.right ? (
        <div className="grid gap-3 pt-2 pl-2 border-l-2 border-[#CBD5E0] dark:border-[#4A5568]">
          <div>
            <span className="text-xs font-semibold text-[#4A5568] dark:text-[#A0AEC0] block mb-2">
              Branch 1:
            </span>
            <PredicateNodeEditor
              node={node.left}
              onChange={(updated) => onChange({ ...node, left: updated })}
              depth={depth + 1}
            />
          </div>
          <div>
            <span className="text-xs font-semibold text-[#4A5568] dark:text-[#A0AEC0] block mb-2">
              Branch 2:
            </span>
            <PredicateNodeEditor
              node={node.right}
              onChange={(updated) => onChange({ ...node, right: updated })}
              depth={depth + 1}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
