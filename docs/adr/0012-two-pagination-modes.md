# 0012 - Two pagination modes: bounded offset and MikroORM cursor

- Status: accepted
- Date: 2026-09-25

## Decision

### Offset (`?page=&pageSize=&sort=`) for table UIs

- Query schema `offsetPageQuery({ sortable })`: `page ≥ 1`, `1 ≤ pageSize ≤ PAGINATION_MAX_PAGE_SIZE`
  (default `PAGINATION_DEFAULT_PAGE_SIZE`), `page × pageSize ≤ PAGINATION_MAX_OFFSET_ROWS`, all
  violations → `422`.
- `sort` is a field from the route's allowlist, `-` prefix for descending. The schema outputs
  `{ field, direction }` typed as the allowlist union, so the client string never reaches SQL; anything
  else (unknown field, `name; DROP …`, `--name`) is `422` with `path: "sort"`. Every sortable field
  must be indexed (spec §3).
- `totalCount` is computed by `countUpTo(db, innerSql, params, PAGINATION_TOTAL_COUNT_CAP)`:
  `SELECT count(*) FROM (<inner> LIMIT cap+1)`, so the count never scans more than `cap + 1` rows.
  `Paginator.offset(data, q, counted)`: `counted > cap` → `totalCount = cap`, `totalCountExact = false`.
- `hasMore` is false when the next page would exceed `PAGINATION_MAX_OFFSET_ROWS`, so the API never
  advertises a page it would reject.
- Response: `{ url, data, page, pageSize, totalCount, totalCountExact, hasMore }`, `url` = request
  path without query string (from `RequestContext.path()`).

### Cursor (`?limit=&cursor=`) for feeds, logs, exports, sync

- MikroORM `em.findByCursor(entity, { where, first, after, orderBy, includeCount: false })`.
  `hasNextPage` comes from MikroORM's overfetch (`limit + 1`), `nextCursor = endCursor` only when
  `hasNextPage`.
- `orderBy` must end with a unique key (`{ body: 'asc', id: 'asc' }`) for a stable order.
- Response: `{ url, data, hasMore, nextCursor }` (`nextCursor` is `null` when `hasMore` is false).
- Repositories run the query inside `withClientCursor(cursor, orderBy, run)` (`core/database`), and use
  `txEm.current() ?? txEm.fork()` so the query runs in the current transaction and RLS session. The
  reference pattern is `FixtureRepo.listPage`.

### Cursor failure modes (verified on MikroORM 7.2.1)

The cursor is `base64url(JSON.stringify([sortValues…]))`, not signed. Tampering can only move the
starting point inside the result set the caller is already allowed to read (where clause and RLS
still apply, values are bound parameters), so signing is not required. Errors a client cursor can
cause, all mapped to `400 invalid_cursor` (never 500):

| Cursor                                   | MikroORM behaviour                                            | Our handling                               |
| ---------------------------------------- | ------------------------------------------------------------- | ------------------------------------------ |
| not base64/JSON (`not-a-real-cursor`)    | `CursorError.invalidCursor`                                   | caught → 400                               |
| valid JSON, wrong arity or not an array  | **silently ignored**, returns the first page (200)            | `withClientCursor` checks arity first → 400 |
| right arity, value of the wrong type     | `CursorError` or Postgres data exception (SQLSTATE class 22) | caught → 400                               |

Other errors (timeouts, connection loss) are rethrown unchanged and follow the DB error table.
The silent-ignore row was confirmed by disabling the arity check: the forged-cursor test got `200`.

### LIKE filters

User text in `LIKE`/`ILIKE` goes through `escapeLike` (escapes `\`, `%`, `_` for Postgres' default
escape character `\`) and is always a bound parameter.

## Alternatives rejected

- `findAndCount` for offset lists: counts every matching row; on large tables the count dominates.
  `countUpTo` caps the cost at `PAGINATION_TOTAL_COUNT_CAP + 1` rows.
- Signing cursors (HMAC): adds a secret and rotation for no security gain (see above).
- Hand-written keyset pagination: MikroORM already implements it.
