"use client";

import type { ReactNode } from "react";
import { useState } from "react";
import { Button } from "@/core/ui/Button";
import { cn } from "@/core/lib/cn";

export interface VirtualizedListProps<T> {
  items: readonly T[];
  getKey: (item: T, index: number) => string;
  renderItem: (item: T, index: number) => ReactNode;
  label: string;
  rowHeight?: number;
  viewportHeight?: number;
  hasMore?: boolean;
  onLoadMore?: () => void;
  loadingMore?: boolean;
  className?: string;
}

export function VirtualizedList<T>({
  items,
  getKey,
  renderItem,
  label,
  rowHeight = 56,
  viewportHeight = 360,
  hasMore = false,
  onLoadMore,
  loadingMore = false,
  className
}: VirtualizedListProps<T>) {
  const [scrollTop, setScrollTop] = useState(0);
  const overscan = 3;
  const visibleCount = Math.ceil(viewportHeight / rowHeight);
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const end = Math.min(items.length, start + visibleCount + overscan * 2);

  return (
    <div className={cn("space-y-3", className)}>
      <div
        role="grid"
        aria-label={label}
        aria-rowcount={items.length + (hasMore ? 1 : 0)}
        className="overflow-y-auto"
        style={{ height: viewportHeight }}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      >
        <div style={{ height: items.length * rowHeight, position: "relative" }}>
          {items.slice(start, end).map((item, offset) => {
            const index = start + offset;
            return (
              <div
                key={getKey(item, index)}
                role="row"
                aria-rowindex={index + 1}
                className="absolute inset-x-0"
                style={{ height: rowHeight, top: index * rowHeight }}
              >
                {renderItem(item, index)}
              </div>
            );
          })}
        </div>
      </div>
      {hasMore && onLoadMore ? (
        <Button type="button" variant="secondary" onClick={onLoadMore} disabled={loadingMore}>
          {loadingMore ? "Loading more..." : "Load more"}
        </Button>
      ) : null}
    </div>
  );
}