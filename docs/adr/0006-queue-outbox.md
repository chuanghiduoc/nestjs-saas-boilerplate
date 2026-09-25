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
  role that can SELECT/UPDATE the outbox), claims rows `FOR UPDATE SKIP LOCKED` and
  enqueues `core.event.dispatch` (`jobId = outbox-<id>`); poison rows are parked after
  `OUTBOX_MAX_PUBLISH_ATTEMPTS`.
- `core.event.dispatch` reads the row with `RelayDb` and either re-enqueues a deferred job
  (`core.job.deferred`, same `jobId` and meta) or enqueues one `core.event.deliver` per
  subscriber with `jobId = deliver-<consumer>-<outboxId>`, so a re-dispatch does not create
  duplicates while the old job is retained.
- `core.event.deliver` parses the envelope with the schema registered for `type@version`
  (invalid → `JobPayloadError`, no retry) and runs the subscriber in `UnitOfWork` +
  `Inbox.once(consumer, eventId)` in the event's org scope. One failing subscriber retries
  only its own job.
- `processed_events (consumer, event_id)` PK + `INSERT … ON CONFLICT DO NOTHING` in the
  same transaction as the side effect is the final exactly-once-effect guard (BullMQ
  jobId dedupe only holds while the job is retained). Side effects outside the database
  must be idempotent keyed by the event id.
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
