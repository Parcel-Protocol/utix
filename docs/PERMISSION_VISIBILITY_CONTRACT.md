# Permission changes and hidden record contract (#362)

Paginated readers must apply current authorization before locating the cursor
anchor, slicing a page, or deciding `hasMore`. `paginateByCursor` accepts an
`isVisible` predicate for this boundary. Callers must recompute it from the
current actor and policy on every request; cursors are continuation hints, not
authorization grants.

The contract suite in
`core/contract/__tests__/visibility-pagination.contract.test.ts` checks normal
reads, revoked access between pages, hidden/deleted cursor anchors, and a role
without dashboard permission. Hidden records are omitted from both results and
the continuation signal. If access is revoked, discard the cursor and retry
only after authorization is restored. The cursor format and visible-row order
remain unchanged for authorized consumers.
