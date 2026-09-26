"use client";

import { useCallback, useRef, useState } from "react";
import { cn } from "@/core/lib/cn";

export interface AccessibleGridColumn<T> {
  key: string;
  header: string;
  sortable?: boolean;
  render: (item: T, index: number) => React.ReactNode;
}

export interface AccessibleGridProps<T> {
  columns: AccessibleGridColumn<T>[];
  rows: T[];
  rowKey: (item: T, index: number) => string;
  caption: string;
  sortBy?: string;
  sortAscending?: boolean;
  onSort?: (key: string, ascending: boolean) => void;
  className?: string;
  virtualizer?: {
    overscan?: number;
    estimateSize?: () => number;
  };
}

export function AccessibleGrid<T>({
  columns,
  rows,
  rowKey,
  caption,
  sortBy,
  sortAscending = true,
  onSort,
  className,
  virtualizer
}: AccessibleGridProps<T>) {
  const [focusedCell, setFocusedCell] = useState<{ row: number; col: number } | null>(null);
  const gridRef = useRef<HTMLTableElement>(null);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTableElement>) => {
      if (!focusedCell) return;

      const { row, col } = focusedCell;
      let newRow = row;
      let newCol = col;

      switch (event.key) {
        case "ArrowUp":
          newRow = Math.max(0, row - 1);
          event.preventDefault();
          break;
        case "ArrowDown":
          newRow = Math.min(rows.length - 1, row + 1);
          event.preventDefault();
          break;
        case "ArrowLeft":
          newCol = Math.max(0, col - 1);
          event.preventDefault();
          break;
        case "ArrowRight":
          newCol = Math.min(columns.length - 1, col + 1);
          event.preventDefault();
          break;
        case "Home":
          if (event.ctrlKey) {
            newRow = 0;
            newCol = 0;
          } else {
            newCol = 0;
          }
          event.preventDefault();
          break;
        case "End":
          if (event.ctrlKey) {
            newRow = rows.length - 1;
            newCol = columns.length - 1;
          } else {
            newCol = columns.length - 1;
          }
          event.preventDefault();
          break;
        case " ":
        case "Enter":
          if (columns[newCol]?.sortable && sortBy !== columns[newCol]?.key) {
            onSort?.(columns[newCol].key, true);
          } else if (columns[newCol]?.sortable && sortBy === columns[newCol]?.key) {
            onSort?.(columns[newCol].key, !sortAscending);
          }
          event.preventDefault();
          break;
        default:
          return;
      }

      setFocusedCell({ row: newRow, col: newCol });

      const cellId = `grid-cell-${newRow}-${newCol}`;
      const cell = document.getElementById(cellId);
      cell?.focus();
    },
    [focusedCell, rows.length, columns, sortBy, sortAscending, onSort]
  );

  const handleCellFocus = (row: number, col: number) => {
    setFocusedCell({ row, col });
  };

  const handleHeaderClick = (key: string) => {
    if (onSort) {
      if (sortBy === key) {
        onSort(key, !sortAscending);
      } else {
        onSort(key, true);
      }
    }
  };

  return (
    <div className={cn("overflow-x-auto", className)}>
      <table
        ref={gridRef}
        className="w-full min-w-[36rem] border-collapse text-left text-sm"
        role="grid"
        aria-label={caption}
        onKeyDown={handleKeyDown}
      >
        <caption className="sr-only">
          {caption}. {rows.length} rows total. Use arrow keys to navigate, Home/End to jump, Space to sort.
        </caption>
        <thead>
          <tr className="border-b border-[#e3ebf5]" role="row">
            {columns.map((column, colIndex) => (
              <th
                key={column.key}
                scope="col"
                className={cn("py-2 pr-4 font-bold text-[#4e5c73]", column.sortable && "cursor-pointer")}
                role="columnheader"
                aria-sort={
                  sortBy === column.key
                    ? sortAscending
                      ? "ascending"
                      : "descending"
                    : "none"
                }
                tabIndex={0}
                id={`grid-header-${column.key}`}
                onClick={() => handleHeaderClick(column.key)}
                onKeyDown={(e) => {
                  if ((e.key === " " || e.key === "Enter") && column.sortable) {
                    handleHeaderClick(column.key);
                  }
                }}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr
              key={rowKey(row, rowIndex)}
              className="border-b border-[#f0f4f9] last:border-0"
              role="row"
              aria-rowindex={rowIndex + 2}
            >
              {columns.map((column, colIndex) => (
                <td
                  key={`${rowKey(row, rowIndex)}-${column.key}`}
                  className="py-3 pr-4 text-[#172033]"
                  role="gridcell"
                  aria-colindex={colIndex + 1}
                  id={`grid-cell-${rowIndex}-${colIndex}`}
                  tabIndex={focusedCell?.row === rowIndex && focusedCell?.col === colIndex ? 0 : -1}
                  onFocus={() => handleCellFocus(rowIndex, colIndex)}
                >
                  {column.render(row, rowIndex)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="sr-only" role="status">
        Showing {rows.length} of {rows.length} rows
      </div>
    </div>
  );
}
