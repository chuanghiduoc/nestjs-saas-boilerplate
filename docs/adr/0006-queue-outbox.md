# 0006 - Jobs and integration events: BullMQ, transactional outbox, inbox

- Status: accepted
- Date: 2026-09-25

## Decision

### Queue: BullMQ directly, not `@nestjs/bullmq`

- `src/core/queue` wraps BullMQ (`JobQueue`, `WorkerHost`, `defineQueue`/`defineJob`,
  `@JobHandler`). `bullmq` is imported only in `src/core/queue/**`.
- Reason: workers are created at runtime from `WORKER_QUEUES` (one image, many worker
  roles), which `@nestjs/bullmq`'s static `@Processor` registration does not model; and
  handlers must not import BullMQ (they receive `JobContext` with `signal`, `meta`,
  validated payload).
- Every job on a consumed queue must have a handler, or worker boot fails.
  `JobPayloadError` (bad payload, meta, jobId, delay; also when thrown by a handler for
  bad data it read) becomes `UnrecoverableError`: no retry.
- Queues of kind `cpu` are declared but rejected at worker boot: sandboxed processors are
  not implemented yet.
- Exactly one `ioredis` version in the tree (`pnpm why ioredis` → `ioredis@6.0.0`, shared
  by our code and BullMQ).

### Outbox → dispatch → deliver; inbox is the dedupe guard

- `EventPublisher.publish` / `SafeEnqueue` write `outbox_events` inside the business
  transaction (`OutboxWriter`, `app_user` has INSERT only). The org always comes from
  `RequestContext`.
- `OutboxRelay` (worker only) runs on the `relay` connection (role `app_relay`, the only
  role that can SELECT/UPDATE the outbox), claims rows with a lease (`claimed_until`, see
  "No external I/O inside a DB transaction" below) and enqueues `core.event.dispatch`
  (`jobId = outbox-<id>`); poison rows are parked after `OUTBOX_MAX_PUBLISH_ATTEMPTS`.
- `core.event.dispatch` reads the row with `RelayDb` and either re-enqueues a deferred job
  (`core.job.deferred`, same `jobId` and meta) or enqueues one `core.event.deliver` per
  subscriber with `jobId = deliver-<consumer>-<outboxId>`, so a re-dispatch does not create
  duplicates while the old job is retained.
- `core.event.deliver` parses the envelope with the schema registered for `type@version`
  (invalid → `JobPayloadError`, no retry) and runs the subscriber in `UnitOfWork` +
  `Inbox.once(consumer, eventId)` in the event's org scope. One failing subscriber retries
  only its own job.
- `processed_events (consumer, event_id)` PK + `INSERT … ON CONFLICT DO NOTHING` in the
  same transaction as the subscriber's **database** side effect is the final
  exactly-once-effect guard (BullMQ jobId dedupe only holds while the job is retained).
- A subscriber's `handle()` does database work only. It never calls HTTP, Redis, SMTP, or any
  other external system inside that transaction (see "No external I/O inside a DB
  transaction"). To cause an external side effect, `handle()` calls `SafeEnqueue.enqueue` (or
  `EventPublisher.publish`) inside the transaction, which writes the outbox, so the job commits
  atomically with the inbox record. The job's handler then runs outside any transaction, calls
  `HttpClient`, and must be idempotent, using the event id as the provider's idempotency key.
- Unknown job/subscriber/event at dispatch or deliver is a configuration error (e.g. a
  rolling deploy with mixed versions): ordinary error, retried, then left in the failed set.
  A defined event with no subscriber in the dispatching worker completes (nothing to do).
- Fan-out uses the **dispatching worker's** subscriber registry. A subscriber added in a
  new release only receives events dispatched after every worker runs that release; there
  is no backfill. Operational rule: a new consumer starts from "events dispatched after full
  rollout"; if it needs history, ship a one-off backfill job.
- The org of a dispatch/deliver job (`meta.orgId`, which sets the `OrgScope`) must equal
  the outbox row's `org_id` (null included). A mismatch is logged as
  `securityEvent: event_org_mismatch` and fails with `JobPayloadError` before the inbox is
  touched, so a forged or mis-scoped job can neither write under another tenant's RLS nor
  mark the event processed.
- `EventPublisher` validates the full envelope (`parseEnvelope`) before writing, so a
  caller bug fails inside the caller's transaction instead of committing an undeliverable
  event.

### SafeEnqueue

Inside a transaction the job always goes through the outbox (sent only after commit);
outside, it goes to Redis directly and falls back to the outbox on a transport error. The
`jobId` is generated once and used on both paths. `delayMs` of a deferred job counts from
dispatch time, not from the original call (relay lag adds to the delay).

### PgBouncer image

`edoburu/pgbouncer` (no official image), pinned by digest in `docker/images.env`
(chosen in the infra task). The `relay` and migration connections go directly to
Postgres; the `app` connection goes through PgBouncer.

### Scheduler: static crons, tenant schedules, retention

- Static crons (`defineCron`) and tenant schedules (`scheduled_tasks`, RLS) both use BullMQ
  Job Schedulers (`JobScheduler` in `core/queue`). A static cron is removed only via
  `retireCron` (rolling-deploy safe). `ScheduleReconciler` (worker, `RelayDb`) repairs tenant
  schedulers from the table.
- **Tenant minimum interval: custom check on top of cron-parser.** cron-parser (BullMQ's own
  parser) parses and iterates the cron, but it has no "minimum gap between runs" API.
  Rejected candidates:
  - Sampling the next N runs misses clustered times (`0,1,20,40 8 * * 1`: 60 s apart once an
    hour, but three consecutive samples can all be ≥ 20 min apart).
  - Iterating a full year with cron-parser is exact, but costs ~105k iterations and ~1 s of
    synchronous CPU for `*/5 * * * *`, on the API request path, per upsert.

  Chosen approach (`src/core/scheduler/schedule-validation.ts`):
  1. The hour×minute grid of `expr.fields` gives a cheap, conservative lower bound on the
     wall-clock gap, including the wrap across midnight.
  2. Real instants are iterated with cron-parser `prev()` / `next()` (`DST_RUNS_EACH_SIDE`
     runs on each side) around each UTC-offset change of the timezone in the next 366 days.
     The transitions are found with `Intl.DateTimeFormat` `longOffset` and bisection. This
     catches DST spring-forward squeezes (`0,59 1,3 * * *` in `America/New_York` fires 60 s
     apart) at a fixed cost of a few milliseconds.
  - If cron-parser throws around an offset change, or returns non-monotonic times, the
    upsert is rejected with 422. This happens with cron-parser 5.10.1 in `Pacific/Chatham`
    and `Australia/Lord_Howe`, for example. BullMQ's `defaultRepeatStrategy` uses the same
    parser and swallows the error, so the scheduler would silently stop.
- Timezones are validated with `Intl`: `resolvedOptions().timeZone` must be `UTC` or appear in
  `Intl.supportedValuesOf('timeZone')`. The name is stored exactly as given, except that a
  case-only difference is fixed. ICU may rename a zone to a legacy link
  (`Asia/Ho_Chi_Minh` → `Asia/Saigon`), so the canonical name is not what gets stored.
- Retention invariants are enforced at boot in every environment (`defineConfigRule`):
  - `OUTBOX_RETENTION_DAYS > QUEUE_KEEP_FAILED_AGE_SEC`
  - `INBOX_RETENTION_DAYS > OUTBOX_RETENTION_DAYS + QUEUE_KEEP_FAILED_AGE_SEC`

### No external I/O inside a DB transaction (ruling R22)

**Rule.** No code may hold a database transaction open while it calls Redis, HTTP, or any
other external system. A transaction is only as long as its SQL statements. External I/O
happens between transactions, and correctness across that gap comes from idempotency keys
and leases, never from row locks.

The rule applies equally to the relay, to event subscribers (`handle()` runs inside
`UnitOfWork` + `Inbox.once`), to job handlers that open a `UnitOfWork`, and to request
handlers. For example, a subscriber that calls a provider through `HttpClient` (up to
`timeout × (retries + 1)`, about 30 s with the defaults) would be killed by
`idle_in_transaction_session_timeout` and leak an `app` pool client through the kysely bug
below. The pattern is: DB work plus `SafeEnqueue` inside the transaction, and the external
call in the enqueued job, outside any transaction.

**Why.** Task 19's chaos test (`test/chaos/redis-outage.spec.ts`) found that the old
`OutboxRelay` claimed rows `FOR UPDATE SKIP LOCKED` and called `JobQueue.enqueueMany` inside
the same transaction:

- A BullMQ `Queue` created while Redis is down waits for `ready` with no bound
  (`RedisConnection.init`). The `commandTimeout`/`maxRetriesPerRequest` settings of ioredis
  only bound commands that are sent after the first `ready`.
- Once the wait passed `idle_in_transaction_session_timeout`, Postgres killed the session, and
  the rollback on the dead connection failed.
- A kysely bug (below) then leaked the pooled client, so `DB_RELAY_POOL_MAX` connections were
  eventually gone. The outbox stopped publishing silently, and shutdown hung on `pool.end()`.

**Lease-based claim** (`src/core/outbox/outbox.relay.ts`). Each step is one autocommit
statement on `RelayDb`, which is its own implicit transaction. kysely releases the client of
a non-transactional query in a `finally`, so none of these statements can leak a client:

1. **Claim.**
   ```sql
   UPDATE outbox_events SET claimed_until = now() + lease, updated_at = now()
   WHERE id IN (SELECT id FROM outbox_events
                WHERE published_at IS NULL AND publish_attempts < max
                  AND (claimed_until IS NULL OR claimed_until < now())
                ORDER BY id LIMIT batch FOR UPDATE SKIP LOCKED)
   RETURNING …
   ```
   The returned `claimed_until` is the batch's lease token.
2. **Poison rows.** Increment `publish_attempts` and clear `claimed_until`, only while the
   batch still owns the lease (`claimed_until = token`).
3. **Enqueue** outside any transaction, bounded by `OUTBOX_ENQUEUE_TIMEOUT_MS`. BullMQ has no
   timeout or abort for `addBulk`, so the relay races the call against a timer and always
   clears the timer. A late completion is only logged and never marks a row.
4. **Mark published.** `SET published_at = now(), claimed_until = NULL … AND published_at IS
   NULL`. A late or duplicate marker is a no-op.

A batch-level failure (timeout, Redis error, DB error after the claim) does not increment
attempts. It releases its own lease (`claimed_until = token`) so the next iteration retries at
once, then backs off. A relay that dies or stalls after claiming blocks its rows only until the
lease expires. Another relay then re-claims them and re-enqueues them with the same
deterministic `jobId`. BullMQ ignores the duplicate while the first job is retained, and the
inbox is the final guard after that.

Config rule `outbox-claim-lease`: `OUTBOX_CLAIM_LEASE_MS ≥ 2 × OUTBOX_ENQUEUE_TIMEOUT_MS`.
The margin (one more enqueue timeout) covers the mark statement and the pool wait after a slow
enqueue. Violating the rule only causes redundant, deduplicated enqueues, not incorrect ones.
There is deliberately no longer a rule tying the enqueue timeout to
`idle_in_transaction_session_timeout`, because no transaction is open while waiting.

Index: `outbox_events_unpublished_idx (id) WHERE published_at IS NULL` is kept. `now()` is
not immutable and max attempts is config, so neither can go in the predicate. `FOR UPDATE`
must visit the heap to lock the row anyway, so `INCLUDE` columns buy nothing. Measured on
Postgres 18.6 with 2.02M rows (20k unpublished, 200 leased, 50 parked): an index scan on
`outbox_events_unpublished_idx`, 250 rows removed by the filter, a batch of 100 claimed in
0.99 ms (`EXPLAIN (ANALYZE, BUFFERS)`, 2,217 shared hits). A claimed but unpublished row
still counts in `outbox_lag_seconds`, because lag measures unpublished rows.

Race table and tests: `test/integration/core/outbox/outbox.spec.ts` (two/three concurrent
relays, crash between enqueue and mark, lease expiry) and
`test/chaos/outbox-relay-outage.spec.ts` (Redis outage: the batch returns within the timeout
with no `idle in transaction` session; repeated outages longer than
`idle_in_transaction_session_timeout` do not starve the relay pool).

#### kysely 0.29.6: a client is not released when rollback or commit fails

- **Version:** kysely 0.29.6, the latest release. It is pinned by `@mikro-orm/sql` 7.2.1.
  The same code is still in 0.30.0-beta.2 (`dist/kysely.js:790`).
- **File:** `kysely/dist/kysely.js` (source `src/kysely.ts`).
- **Functions:** `ControlledTransaction.rollback()` (and `commit()`).

```js
rollback() {
  return new Command(async () => {
    await this.#props.driver.rollbackTransaction(this.#props.connection.connection);
    this.#state.isRolledBack = true;
    this.#props.connection.release();   // skipped when the ROLLBACK throws
  });
}
```

If the connection is dead (the session was killed by `idle_in_transaction_session_timeout`, a
failover, or a network drop), `rollbackTransaction` throws and `release()` never runs.
MikroORM's `AbstractSqlConnection.transactional` only logs a warning, so the client stays
checked out forever. `TransactionBuilder.execute` and `DefaultConnectionProvider` do not have
this bug, because they release in `finally`.

**No patched library.** The user forbids custom or patched versions of dependencies
(framework → package → own code, never a fork). We remove the only known trigger in our code
instead: no transaction is open across external I/O. Residual risk: any other transaction
whose connection dies mid-way can still leak one client. The operational signal is a relay or
app pool that stops serving, and shutdown hanging on `pool.end()`.

**Upstream issue (ready to file; not filed, the user decides):**

> **Title:** `ControlledTransaction.rollback()`/`commit()` never release the connection when
> the driver call throws
>
> **Version:** kysely 0.29.6 (latest), `pg` dialect, via MikroORM 7.2.1. Also present in
> 0.30.0-beta.2 (`dist/kysely.js:790`).
>
> **What happens:** `ControlledTransaction.rollback()` runs
> `await driver.rollbackTransaction(conn)` and only then `connection.release()`. The same is
> true for `commit()`. If the connection is already broken, for example because Postgres
> terminated the session (`idle_in_transaction_session_timeout`, `pg_terminate_backend`,
> failover), the driver call rejects and `release()` is skipped. The pooled client is never
> returned, so after `pool.max` such events the pool is exhausted and `pool.end()` never
> resolves.
>
> **Reproduce:** a checked-out `pg` client has no pool `error` listener, so without step 0 a
> terminated session crashes the process with an unhandled `'error'` event before the leak can
> be observed. MikroORM attaches such a listener, which is why applications leak instead of
> crashing.
>
> ```ts
> import { Kysely, PostgresDialect, sql } from 'kysely';
> import pg from 'pg';
>
> const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
> pool.on('connect', (c) => c.on('error', () => {})); // step 0
> const db = new Kysely({ dialect: new PostgresDialect({ pool }) });
> const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
> await admin.connect();
>
> const trx = await db.startTransaction().execute();
> const { rows } = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(trx);
> await admin.query('select pg_terminate_backend($1)', [rows[0].pid]);
> await trx.rollback().execute().catch((e) => console.log('rollback failed:', e.message));
> console.log('total', pool.totalCount, 'idle', pool.idleCount); // total 1 idle 0
> await Promise.race([
>   pool.query('select 1').then(() => console.log('pool usable')),
>   new Promise((r) => setTimeout(() => r(console.log('pool exhausted: select 1 still waiting')), 2000)),
> ]);
> ```
>
> **Expected:** the connection is released (ideally destroyed, since it is broken) whether or
> not ROLLBACK/COMMIT succeeds, the same way `TransactionBuilder.execute` and
> `DefaultConnectionProvider.provideConnection` release in `finally`.
>
> **Suggested fix:** wrap the driver call in `try { … } finally { connection.release() }` in
> both `commit()` and `rollback()`. Optionally, pass the error to the pool so the broken
> client is discarded.

A second, optional issue for MikroORM: `AbstractSqlConnection.transactional` could destroy the
connection when rollback fails, instead of only logging a warning.
