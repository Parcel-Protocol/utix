/** A stable, total order for operational records and their event streams. */

export interface MixedStatusRecord {
  readonly id: string;
  readonly status: string;
  readonly updatedAt?: string | number | Date | null;
  readonly sequence?: number | null;
}

export interface MixedStatusEvent {
  readonly id: string;
  readonly status: string;
  readonly at?: string | number | Date | null;
  readonly sequence?: number | null;
}

/** Actionable/unsafe states precede in-flight and terminal states. */
export const STATUS_PRIORITY: Readonly<Record<string, number>> = Object.freeze({
  failed: 0,
  dead_lettered: 0,
  interrupted: 1,
  retrying: 1,
  pending: 2,
  queued: 2,
  running: 3,
  succeeded: 4,
  completed: 4,
  resolved: 4,
  skipped: 5,
  abandoned: 6,
  cancelled: 6
});

function text(a: string, b: string): number {
  return a === b ? 0 : a < b ? -1 : 1;
}

function time(value: string | number | Date | null | undefined): number {
  if (value === null || value === undefined) return Number.NEGATIVE_INFINITY;
  const parsed = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function priority(status: string): number {
  return STATUS_PRIORITY[status] ?? 7;
}

function sequence(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

/** Status first, then newest update, highest sequence, status text and id. */
export function compareMixedStatusRecords<T extends MixedStatusRecord>(a: T, b: T): number {
  return priority(a.status) - priority(b.status) ||
    time(b.updatedAt) - time(a.updatedAt) ||
    sequence(b.sequence) - sequence(a.sequence) ||
    text(a.status, b.status) ||
    text(a.id, b.id);
}

/** Newest event first, then status, sequence and id for timestamp ties. */
export function compareMixedStatusEvents<T extends MixedStatusEvent>(a: T, b: T): number {
  return time(b.at) - time(a.at) ||
    priority(a.status) - priority(b.status) ||
    sequence(b.sequence) - sequence(a.sequence) ||
    text(a.status, b.status) ||
    text(a.id, b.id);
}

export interface DeterministicSortOptions<T> {
  readonly isVisible?: (item: T) => boolean;
}

export interface KeysetPageOptions<T> extends DeterministicSortOptions<T> {
  readonly cursor?: string;
  readonly limit?: number;
}

export interface KeysetPageResult<T> {
  readonly items: readonly T[];
  readonly total: number;
  readonly nextCursor?: string;
  readonly hasMore: boolean;
}

export interface DeterministicOrderingVerification {
  readonly isDeterministic: boolean;
  readonly inversions: number;
  readonly violations: readonly string[];
}

export function sortMixedStatusRecords<T extends MixedStatusRecord>(
  records: readonly T[],
  options?: DeterministicSortOptions<T>
): T[] {
  const filtered = options?.isVisible ? records.filter(options.isVisible) : records;
  return [...filtered].sort(compareMixedStatusRecords);
}

export function sortMixedStatusEvents<T extends MixedStatusEvent>(
  events: readonly T[],
  options?: DeterministicSortOptions<T>
): T[] {
  const filtered = options?.isVisible ? events.filter(options.isVisible) : events;
  return [...filtered].sort(compareMixedStatusEvents);
}

/** Explicit aliases for status feeds and event feeds exposed by callers. */
export const sortStatusList = sortMixedStatusRecords;
export const sortEventList = sortMixedStatusEvents;

export function pageMixedStatusRecords<T extends MixedStatusRecord>(
  records: readonly T[],
  options?: KeysetPageOptions<T>
): KeysetPageResult<T> {
  const sorted = sortMixedStatusRecords(records, options);
  const limit = Math.max(1, options?.limit ?? 20);

  let startIndex = 0;
  if (options?.cursor) {
    const cursorIndex = sorted.findIndex((r) => r.id === options.cursor);
    if (cursorIndex !== -1) {
      startIndex = cursorIndex + 1;
    }
  }

  const items = sorted.slice(startIndex, startIndex + limit);
  const nextCursor =
    items.length > 0 && startIndex + items.length < sorted.length
      ? items[items.length - 1].id
      : undefined;

  return {
    items,
    total: sorted.length,
    nextCursor,
    hasMore: nextCursor !== undefined
  };
}

export function pageMixedStatusEvents<T extends MixedStatusEvent>(
  events: readonly T[],
  options?: KeysetPageOptions<T>
): KeysetPageResult<T> {
  const sorted = sortMixedStatusEvents(events, options);
  const limit = Math.max(1, options?.limit ?? 20);

  let startIndex = 0;
  if (options?.cursor) {
    const cursorIndex = sorted.findIndex((e) => e.id === options.cursor);
    if (cursorIndex !== -1) {
      startIndex = cursorIndex + 1;
    }
  }

  const items = sorted.slice(startIndex, startIndex + limit);
  const nextCursor =
    items.length > 0 && startIndex + items.length < sorted.length
      ? items[items.length - 1].id
      : undefined;

  return {
    items,
    total: sorted.length,
    nextCursor,
    hasMore: nextCursor !== undefined
  };
}

export function verifyDeterministicOrdering<T extends MixedStatusRecord | MixedStatusEvent>(
  items: readonly T[],
  kind: "record" | "event"
): DeterministicOrderingVerification {
  const violations: string[] = [];
  let inversions = 0;
  const comparator =
    kind === "record"
      ? (a: T, b: T) => compareMixedStatusRecords(a as MixedStatusRecord, b as MixedStatusRecord)
      : (a: T, b: T) => compareMixedStatusEvents(a as MixedStatusEvent, b as MixedStatusEvent);

  for (let i = 0; i < items.length - 1; i++) {
    const a = items[i];
    const b = items[i + 1];
    const cmp = comparator(a, b);
    if (cmp > 0) {
      inversions += 1;
      violations.push(`Ordering violation between index ${i} ("${a.id}") and index ${i + 1} ("${b.id}")`);
    }
  }

  return {
    isDeterministic: inversions === 0,
    inversions,
    violations
  };
}
