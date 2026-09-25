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

### SafeEnqueue

Inside a transaction the job always goes through the outbox (sent only after commit);
outside, it goes to Redis directly and falls back to the outbox on a transport error. The
`jobId` is generated once and used on both paths. `delayMs` of a deferred job counts from
dispatch time, not from the original call (relay lag adds to the delay).

### PgBouncer image

`edoburu/pgbouncer` (no official image), pinned by digest in `docker/images.env`
(chosen in the infra task). The `relay` and migration connections go directly to
Postgres; the `app` connection goes through PgBouncer.
