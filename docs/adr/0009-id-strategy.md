# 0009 - ID strategy: BIGINT identity PK, UUIDv7 public id

- Status: accepted
- Date: 2026-09-25

## Decision

- Primary keys: `BIGINT GENERATED ALWAYS AS IDENTITY` (B-tree insert locality,
  compact FKs).
- Externally visible ids: `public_id UUID` generated as UUIDv7 by Postgres
  `uuidv7()` (time-ordered, non-enumerable). Org ids used by RLS
  (`app.org_id`, `app_current_org() RETURNS uuid`) are UUIDs.

## S5 - `uuidv7()` availability

Image `postgres:18.6` (digest pinned in `docker/images.env`) ships `uuidv7()`.
The first migration (`core_bootstrap`) runs `SELECT uuidv7();` so a database
without it fails the migration loudly. Verified by the integration suite's
global migrate and by `node dist/main.migrate.js up` on the compose Postgres.
No application-side fallback (`uuid` v7) is needed.
