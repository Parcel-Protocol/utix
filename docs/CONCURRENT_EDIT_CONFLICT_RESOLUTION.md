# Conflict Resolution for Concurrent Edits (#433)

## Overview

Utix supports concurrent multi-party edits with optimistic concurrency control (OCC) and intelligent 3-way merge conflict resolution.

`core/conflict/resolver.ts` prevents lost updates, ensures atomicity, and provides actionable conflict diff reports when concurrent mutations clash.

## Conflict Strategies

1. `three-way-merge` (Default):
   - Computes diff of concurrent changes against common ancestor base version.
   - Automatically commits non-overlapping field modifications.
   - Raises `edit_conflict_detected` when identical fields diverge concurrently.

2. `reject-on-conflict`:
   - Strictly refuses any edit if version has advanced since caller read snapshot.

3. `last-write-wins`:
   - Explicit override policy taking newest edit without merge rejection.

## Conflict Report Structure

```ts
interface ConflictReport<T> {
  hasConflict: boolean;
  conflictingFields: (keyof T)[];
  currentValues: Partial<T>;
  attemptedValues: Partial<T>;
  baseValues?: Partial<T>;
}
```

## Rebase & Retry Flow

```
[ Read Base Document ] ---> [ Construct Patch ] ---> [ Attempt Commit ]
                                                            |
                                        [ Version Advanced / Stale ]
                                                            |
                                               [ 3-Way Merge Evaluation ]
                                              /                        \
                                     (Clean Disjoint)            (Overlapping Clash)
                                            |                             |
                                      [ Merge & Save ]         [ Emit Conflict Report / Retry ]
```
