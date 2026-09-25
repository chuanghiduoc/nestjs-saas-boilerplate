# 0003 - ORM: MikroORM 7, two connections (`app`/`relay`), no global EntityManager, guarded migrations

- Status: accepted
- Date: 2026-09-25

## Decision

- Packages (exact pins via `saveExact`, installed with `pnpm add <name>` after
  `pnpm view <name> dist-tags peerDependencies`):
  `@mikro-orm/core`, `@mikro-orm/postgresql`, `@mikro-orm/migrations`,
  `@mikro-orm/cli` (dev) = **7.2.1**; `@mikro-orm/nestjs` = **7.1.0**. The Nest
  integration is released separately; its peers are
  `@mikro-orm/core ^7.0.0`, `@nestjs/common|core ^11.0.5 || ^12.0.0`, so 7.1.0
  is compatible with core 7.2.1 and Nest 12. Only the pre-existing, unrelated
  `tsconfck` → `typescript ^5` peer warning remains (`pnpm peers check`).
- Two MikroORM contexts registered with `MikroOrmModule.forRootAsync({ contextName })`:
  - `app` (role `app_user`, through PgBouncer transaction mode in production) for
    all business SQL; RLS enforced.
  - `relay` (role `app_relay`, direct Postgres) only in the worker
    (`DatabaseModule.forRoot({ relay: true })`) for outbox relay/cleanup/metrics.
- The global EM is never used: `allowGlobalContext: false`,
  `registerRequestContext: false`. `TxEm` injects `@InjectEntityManager('app')`,
  forks with `disableContextResolution: true` and binds the fork into CLS
  (`CTX.em`). `UnitOfWork.run` forks when nothing is bound, joins when a
  transaction is already open.
- All SQL goes through `Db.execute` (`em.execute` on the bound EM → current
  transaction + `sessionContext: 'transaction'` RLS variables) or `RelayDb`.
  `getConnection().execute` is never used.
- Timeouts live on the roles (Task 2). Worker transactions add
  `set_config('statement_timeout', …, true)` (= `SET LOCAL`). No startup
  parameters on the `app` connection because PgBouncer transaction mode drops them.
- Migrations: owner role, direct Postgres; `lock_timeout`/`statement_timeout`
  sent as pg startup parameters (`driverOptions`), `transactional` +
  `allOrNothing`. `migrate down` requires a target (`0` = all) and refuses a name
  that is not in the executed list.

## Verified API facts (MikroORM 7.2.1 / @mikro-orm/nestjs 7.1.0 sources in node_modules)

- `getEntityManagerToken(name)` = `` `${name}_EntityManager` ``; the provider value
  is `orm.em` (root EM, runtime class `PostgreSqlEntityManager`).
- `@mikro-orm/nestjs` keeps registered context names in a module-level array and
  throws `ContextName 'app' already registered` if the same context is registered
  twice in one process before `onApplicationShutdown` clears it. One app per
  process is fine; tests must open apps sequentially.
- `SqlEntityManager.execute` uses the EM's transaction context and wraps the call
  in `withSessionContext` (short implicit transaction when a session context is
  set and no transaction is open). Params use `?` placeholders and are
  interpolated by the platform (`formatQuery`).
- `em.fork()` copies the parent's session context (or takes `session`);
  `em.transactional` forks and passes `sessionContext` to `begin()`, which runs
  `set_config(…, true)` inside the transaction. `isolationLevel` accepts the
  string literals `'read committed' | 'repeatable read' | 'serializable'`.
- Root EM `getContext()` prefers the AsyncLocalStorage transaction context;
  forking with `disableContextResolution: true` avoids depending on it.
- Pool: `pool: { min, max }`; `driverOptions` is merged into `pg.Pool` options
  (`PostgreSqlConnection.mapOptions`), so `ssl`, `lock_timeout`,
  `statement_timeout` go there. pg sends the timeouts in the startup message.
- `MikroORM.init` merges `MIKRO_ORM_*` env vars under explicit options
  (explicit options win) and connects lazily.
- Migrator: `migrations.migrationsList` (`MigrationObject { name, class }`, type
  exported from `@mikro-orm/core`, not `@mikro-orm/migrations`), `tableName`,
  `orm.migrator.up()/down({ to })/getPending()/getExecuted()`. `down({ to: name })`
  reverts every executed migration **if `name` is not executed** — hence our guard.
  `down({ to: 0 })` reverts everything.
- CLI `migration:create --blank --path --name` needs a reachable database
  (`databaseExists` check) even for a blank migration.

## S4 - migrations in module sub-folders

`src/migrations/core/*.ts` builds to `dist/migrations/core/*.js`; the runner with
`path: 'dist/migrations', glob: '**/*.js'` (node `fs.globSync`) finds files in
sub-folders. Verified: `node dist/main.migrate.js status|up|down 0|up` against
Postgres 18.6 (and with `docker compose` from the generated `.env.example`).
The migration name is the file name without extension, identical to the class
name used by the test runner's `migrationsList`, so both write the same rows.

## Consequences

- Migration files import `@mikro-orm/migrations` from `src/migrations/**`; the
  import-boundary rule must allow that folder.
- `cwd` of the migrate process must be the app root (`dist/migrations` is relative).
