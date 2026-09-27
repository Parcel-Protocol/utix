"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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

const cellId = (row: number, col: number) => `grid-cell-${row}-${col}`;

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

  /**
   * Key of the row that currently owns DOM focus, tracked separately from the
   * row *index*. A virtualized list recycles DOM nodes and a sorted/filtered
   * dataset moves rows from one index to another; the key is what stays stable,
   * so it is what focus restoration must follow.
   */
  const focusedRowKeyRef = useRef<string | null>(null);
  /** Whether focus was inside the grid just before the current commit. */
  const gridHadFocusRef = useRef(false);

  const clampRow = (row: number) => Math.max(0, Math.min(rows.length - 1, row));
  const clampCol = (col: number) => Math.max(0, Math.min(columns.length - 1, col));

  const moveFocus = useCallback((row: number, col: number) => {
    setFocusedCell({ row, col });
    document.getElementById(cellId(row, col))?.focus();
  }, []);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTableElement>) => {
      if (!focusedCell || rows.length === 0 || columns.length === 0) return;

      const { row, col } = focusedCell;
      let newRow = row;
      let newCol = col;

      switch (event.key) {
        case "ArrowUp":
          newRow = clampRow(row - 1);
          event.preventDefault();
          break;
        case "ArrowDown":
          newRow = clampRow(row + 1);
          event.preventDefault();
          break;
        case "ArrowLeft":
          newCol = clampCol(col - 1);
          event.preventDefault();
          break;
        case "ArrowRight":
          newCol = clampCol(col + 1);
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
          if (columns[col]?.sortable && sortBy !== columns[col].key) {
            onSort?.(columns[col].key, true);
          } else if (columns[col]?.sortable && sortBy === columns[col].key) {
            onSort?.(columns[col].key, !sortAscending);
          }
          event.preventDefault();
          break;
        default:
          return;
      }

      // A boundary key press still lands on the same cell: focus it again so a
      // recycled/remounted node cannot silently lose the caret.
      moveFocus(newRow, newCol);
    },
    [focusedCell, rows.length, columns.length, sortBy, sortAscending, onSort, moveFocus, clampRow, clampCol]
  );

  const handleCellFocus = (row: number, col: number, key: string) => {
    gridHadFocusRef.current = true;
    focusedRowKeyRef.current = key;
    setFocusedCell({ row, col });
  };

  const handleGridBlur = (event: React.FocusEvent<HTMLTableElement>) => {
    const next = event.relatedTarget as Node | null;
    if (next && event.currentTarget.contains(next)) return; // focus moved within the grid
    if (next) {
      // Focus genuinely moved to another widget: stop tracking this row so a
      // background data update cannot yank the caret back.
      gridHadFocusRef.current = false;
      focusedRowKeyRef.current = null;
    }
    // `relatedTarget === null` also happens when the focused node is removed by
    // a data update. Keep the tracked row so the effect below can move focus to
    // a still-rendered cell instead of dropping it on <body>.
  };

  /**
   * Keep the roving tabindex (and, when the grid has focus, the DOM focus) on
   * the same logical row after the data changes. Without this, sorting or a
   * windowed update that unmounts the focused node drops focus to <body>, which
   * is the "visually present but unreachable row" defect this grid guards
   * against.
   */
  useEffect(() => {
    const key = focusedRowKeyRef.current;
    if (!key || rows.length === 0) return;

    const rowIndex = rows.findIndex((row, index) => rowKey(row, index) === key);
    const col = clampCol(focusedCell?.col ?? 0);

    let next: { row: number; col: number };
    if (rowIndex === -1) {
      // The focused row was removed; clamp to a row that still exists.
      const fallbackRow = clampRow(focusedCell?.row ?? 0);
      focusedRowKeyRef.current = rowKey(rows[fallbackRow], fallbackRow);
      next = { row: fallbackRow, col };
    } else {
      next = { row: rowIndex, col };
    }

    if (focusedCell && next.row === focusedCell.row && next.col === focusedCell.col) return;

    setFocusedCell(next);
    if (gridHadFocusRef.current) {
      document.getElementById(cellId(next.row, next.col))?.focus();
    }
  }, [rows, rowKey, focusedCell, clampCol, clampRow]);

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
        aria-rowcount={rows.length + 1}
        aria-colcount={columns.length}
        onKeyDown={handleKeyDown}
        onBlur={handleGridBlur}
      >
        <caption className="sr-only">
          {caption}. {rows.length} rows total. Use arrow keys to navigate, Home/End to jump, Space to sort.
        </caption>
        <thead>
          <tr className="border-b border-[#e3ebf5]" role="row" aria-rowindex={1}>
            {columns.map((column) => (
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
          {rows.map((row, rowIndex) => {
            const key = rowKey(row, rowIndex);
            return (
              <tr
                key={key}
                className="border-b border-[#f0f4f9] last:border-0"
                role="row"
                aria-rowindex={rowIndex + 2}
              >
                {columns.map((column, colIndex) => {
                  const isFocused = focusedCell
                    ? focusedCell.row === rowIndex && focusedCell.col === colIndex
                    : rowIndex === 0 && colIndex === 0;
                  return (
                    <td
                      key={`${key}-${column.key}`}
                      className="py-3 pr-4 text-[#172033]"
                      role="gridcell"
                      aria-colindex={colIndex + 1}
                      id={cellId(rowIndex, colIndex)}
                      tabIndex={isFocused ? 0 : -1}
                      onFocus={() => handleCellFocus(rowIndex, colIndex, key)}
                    >
                      {column.render(row, rowIndex)}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="sr-only" role="status">
        Showing {rows.length} of {rows.length} rows
      </div>
    </div>
  );
}
