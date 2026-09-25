# 0005 - Multi-tenant isolation: fail-closed Postgres RLS

- Status: accepted
- Date: 2026-09-25

## Decision

- Every table with `org_id` enables `ROW LEVEL SECURITY` **and** `FORCE ROW LEVEL
  SECURITY`, with exactly one standard policy:
  `USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org())`.
- `app_current_org()` (migration `core_bootstrap`) raises
  `org context is not set` (SQLSTATE `P0001`) when `app.org_id` is NULL **or empty**.
  Policies never read `current_setting()` directly.
- Roles: `app_user` (api/worker business queries) and `app_relay` are
  `NOBYPASSRLS`; `app_owner` owns tables and runs migrations. Privileges are
  granted per table in the migration that creates it (no default privileges).
- Policies are written **only** in migration SQL using the pattern above. The
  MikroORM `rls: true` filter / policy generation is not used, so there is a
  single source of truth for policies.
- Composite (double) foreign keys `(org_id, x_id)` for tenant-to-tenant references
  arrive with sub-project 3.
- A CI check (later task) asserts every table with an `org_id` column has RLS +
  FORCE + a policy calling `app_current_org()`.

## `OrgScope`

`OrgScope.run(orgId, fn)` validates `orgId` as a UUID (`400 org_context_invalid`
otherwise, before touching the database), forks the `app` EntityManager with
`session: { variables: { 'app.org_id': orgId } }`, binds it in CLS and sets
`RequestContext.orgId` in a child CLS context (the parent is unchanged).

Inside an open transaction the session can no longer change. `OrgScope.run`
then only joins the transaction if **its EntityManager's session** carries the
same org; otherwise (other org, or a transaction opened without org) it throws.
The session of the bound EM, not `RequestContext.orgId`, is the reference,
because it is what Postgres actually sees (a context can claim an org while the
transaction has none; test `rejects entering a scope inside a transaction opened
without org session…`).

## Verified MikroORM 7.2.1 behaviour (read from node_modules)

- `EntityManager.fork({ session })` stores the session on the fork
  (`mergeSessionContext`); forks without `session` copy the parent's session.
- With `sessionContext: 'transaction'` (our config), `TransactionManager.processTransaction`
  passes `fork.getTransactionSessionContext()` to `AbstractSqlConnection.begin()`,
  which runs `select set_config(?, ?, true)` right after `BEGIN`
  (`applySessionContext`) and rolls back if that fails.
- A statement outside an explicit transaction on a fork with a session is wrapped
  in a short implicit transaction (`EntityManager.withSessionContext`), so the
  variable is still transaction-local.
- Every `em.transactional()` call creates a fresh fork (`createNewTransaction` →
  `createFork`), so a retried transaction starts from a clean identity map and
  re-applies the session.
- Because `set_config(..., true)` is transaction-local, a pooled connection
  (PgBouncer transaction mode) keeps no org after commit. Postgres keeps the
  custom variable defined as `''` (not NULL) on that backend afterwards; a policy
  using `current_setting('app.org_id', true)::uuid` then fails with
  `invalid input syntax for type uuid: ""` instead of the explicit fail-closed
  error (mutation test result below), which is why the function checks both.

## Database error mapping

`dbErrorMapper` (registered by `DatabaseModule.onModuleInit`) reads the SQLSTATE
from `code` (MikroORM `DriverException` copies every field of the pg error;
errors raised at `COMMIT` are raw pg errors, not converted), `sqlState`, or
`cause.code`:

| SQLSTATE | Result |
| --- | --- |
| 23505 unique, 23503 FK, 23001 restrict | `409 conflict` (or code from `defineConstraintErrors`) |
| 23514 check, 23502 not null | `422 validation_failed` (or registered code) |
| 42501 + RLS message/`routine = ExecWithCheckOptions` | `404 not_found` + security warn log |
| 42501 otherwise (missing GRANT) | unmapped → `500 internal_error` |
| 40001, 40P01, 57014 | `503 service_unavailable` |
| P0001 `org context is not set` | unmapped → `500 internal_error` (a bug) |

Postgres 18 reports a violated `ON DELETE RESTRICT` foreign key as `23001
restrict_violation`, not `23503` (observed in the integration test), so 23001 is
mapped as well. `detail` is never set, so constraint names do not reach clients.

## Transaction retry

The outermost `UnitOfWork.run` retries `40001`/`40P01` up to
`DB_TX_RETRY_ATTEMPTS` times with full-jitter backoff (`DB_TX_RETRY_BASE_MS ·
2^n`). Nested runs join the outer transaction and do not retry. `fn` may run
more than once, so side effects outside the database must go through the outbox.
