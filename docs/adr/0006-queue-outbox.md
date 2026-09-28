# 0006 — BullMQ, outbox giao dịch và inbox

- Trạng thái: Đã chấp nhận
- Ngày: 2026-09-25

## Bối cảnh

Ghi DB rồi enqueue trực tiếp có khoảng trống mất event; giao lại sau crash có thể lặp side effect. Redis gián đoạn không được làm mất ý định nghiệp vụ đã commit. Relay không được giữ transaction trong lúc chờ Redis.

## Quyết định

### Queue và hợp đồng handler

Core bọc BullMQ trực tiếp qua `JobQueue`, `WorkerHost`, `defineQueue`/`defineJob` và `@JobHandler`. Worker được tạo lúc chạy theo `WORKER_QUEUES`; handler nhận `JobContext` gồm payload đã validate, metadata và AbortSignal, không import BullMQ.

Queue được consume phải có đủ handler hoặc boot thất bại. Queue `cpu` có thể khai báo nhưng bị từ chối khi worker boot vì chưa có sandboxed processor. Redis namespace dùng `${keyPrefix}-${nodeEnv}` (R3); BullMQ không cho dấu hai chấm trong prefix/jobId. Cả cây chỉ có một ioredis: version nằm trong pnpm catalog (`pnpm-workspace.yaml`, `package.json` dùng `catalog:`) và `overrides: { ioredis: 'catalog:' }` ép mọi ioredis bắc cầu (bullmq, `@node-idempotency/storage`) về đúng bản đó.

`JobPayloadError` do decode hoặc do handler phát hiện dữ liệu sai đều thành unrecoverable, không retry (R13). Lỗi tạm thời retry theo config. Khi shutdown, drain rồi abort; handler phải tôn trọng signal. Handler return bình thường sau abort vẫn bị đánh dấu lỗi, tránh mất job; lần abort có thể tiêu một attempt.

### Event → dispatch → deliver và inbox

`EventPublisher.publish` validate toàn bộ envelope trước khi ghi outbox trong UnitOfWork. Org lấy từ RequestContext. `OutboxWriter` từ chối gọi ngoài transaction; actor không phải system phải khớp org context.

Relay dùng role `app_relay` qua `RelayDb`, enqueue `core.event.dispatch` với `jobId = outbox-<id>`. Dispatch tạo `core.event.deliver` cho mỗi subscriber với `deliver-<consumer>-<outboxId>`, hoặc gửi lại deferred job bằng jobId/meta gốc.

Deliver chạy trong OrgScope của event, UnitOfWork và `Inbox.once(consumer, eventId)`. PK `processed_events (consumer, event_id)` + `INSERT … ON CONFLICT DO NOTHING` nằm cùng transaction với tác động **trong DB** của subscriber. Đây là bảo đảm chống tác động DB lặp; jobId chỉ dedup khi BullMQ còn giữ job.

Subscriber chỉ làm DB và ghi ý định qua `SafeEnqueue`/`EventPublisher`. Gửi mail, HTTP hay Redis phải ở job ngoài transaction, dùng idempotency key của provider (ví dụ event id). Không coi inbox là bảo đảm exactly-once cho hệ thống ngoài.

- R12: event `type@version` chưa biết hoặc subscriber chưa đăng ký là lỗi thường, được retry để chịu lệch phiên bản khi rolling deploy. Event đã biết nhưng không có subscriber trong worker dispatch thì hoàn tất không làm gì.
- Payload/envelope sai là lỗi vĩnh viễn, không retry. Một subscriber lỗi chỉ retry job của chính nó.
- Meta org của job dispatch/deliver phải bằng `org_id` trên dòng outbox (kể cả null); lệch thì log `event_org_mismatch` và dừng trước inbox.
- Fan-out dùng registry của worker dispatch. Consumer mới nhận event từ sau rollout hoàn chỉnh; không tự backfill lịch sử.
- R10: outbox/inbox là bảng hạ tầng bảo vệ bằng grant, không RLS; app_user chỉ INSERT outbox. R11: inbox dùng PK tự nhiên, vẫn có timestamp tạo/cập nhật.

### SafeEnqueue

Trong transaction luôn ghi `core.job.deferred` vào outbox, không gọi Redis. Ngoài transaction thử Redis, lỗi transport thì ghi outbox với cùng jobId đã sinh. Deferred `delayMs` tính từ lúc dispatch, nên lag relay cộng vào thời gian chờ. `enqueueMany` qua nhiều queue không phải transaction atomic toàn cục.

### Không gọi I/O bên ngoài trong transaction DB (R22)

Quy tắc áp dụng cho relay, request handler, subscriber và job mở UnitOfWork. Chỉ giữ transaction cho thao tác DB; gọi provider ở ngoài, nối hai bước bằng ý định trong outbox và idempotency.

Task 19 phát hiện relay cũ khoá dòng rồi chờ enqueue trong cùng transaction. BullMQ Queue kết nối lần đầu khi Redis đã sập có thể chờ ready không giới hạn; commandTimeout chỉ chặn command sau ready. Quá `idle_in_transaction_session_timeout`, Postgres giết session và lỗi rollback của kysely làm rò client. Ước lượng đã sửa: khoảng một client cho mỗi process/Queue lạnh gặp tình huống đó, không phải một client sau mỗi lần Redis sập.

#### Claim bằng lease

Mỗi bước là một câu SQL autocommit qua RelayDb, tức transaction ngắn riêng:

1. UPDATE claim các dòng chưa publish, dưới ngưỡng attempts, lease chưa có hoặc hết hạn; đặt `claimed_until` bằng giờ DB cộng lease (`src/core/outbox/outbox.relay.ts`):
   ```sql
   UPDATE outbox_events SET claimed_until = now() + lease, updated_at = now()
   WHERE id IN (SELECT id FROM outbox_events
                WHERE published_at IS NULL AND publish_attempts < max
                  AND (claimed_until IS NULL OR claimed_until < now())
                ORDER BY id LIMIT batch FOR UPDATE SKIP LOCKED)
   RETURNING …
   ```
2. Validate dòng; poison row tăng attempts và xoá lease chỉ khi token vẫn thuộc batch.
3. Enqueue **ngoài transaction**, bị giới hạn bởi `OUTBOX_ENQUEUE_TIMEOUT_MS`.
4. Chỉ khi enqueue thành công đúng hạn mới đánh dấu published; điều kiện `published_at IS NULL` làm thao tác đánh dấu lặp thành no-op.
5. Lỗi cả batch không tăng attempts: nhả lease của chính mình, log và backoff. Nhả lease lỗi vẫn log, lease tự hết hạn.

Token lease là epoch microsecond dạng bigint của `claimed_until`, không phụ thuộc DateStyle/TimeZone. Các dòng claim được sắp bằng BigInt(id) trước enqueue. Reject/release có guard token nên relay cũ không xoá lease mới hay tăng attempts hai lần.

`OUTBOX_CLAIM_LEASE_MS ≥ 2 × OUTBOX_ENQUEUE_TIMEOUT_MS` được kiểm tra lúc boot. Relay chết sau claim chỉ chặn dòng tới khi lease hết hạn. Chết sau enqueue trước mark thì gửi lại cùng jobId; inbox là lớp chống trùng cuối cùng.

BullMQ addBulk không có abort/timeout riêng; timer của wrapper luôn được dọn. Enqueue hoàn tất muộn chỉ log, không mark dòng. Chỉ cho tối đa **một** enqueue đã timeout còn pending; các lượt tiếp theo fail-fast tới khi nó settle, tránh tích luỹ promise khi Redis sập lâu.

Giữ index `(id) WHERE published_at IS NULL`: `now()` không immutable, ngưỡng attempts là config; FOR UPDATE vẫn phải đọc heap. Task 19 relay fix đo 2,02 triệu dòng, claim 100 dòng khoảng 0,985 ms, 2.217 shared hits trên Postgres 18.6. Đây là phép đo tình huống cụ thể, không phải cam kết latency.

Các test outbox kiểm tra relay song song, crash giữa enqueue/mark, lease hết hạn, poison row mất lease và enqueue muộn. Chaos test kiểm tra mất Redis lâu hơn idle timeout mà relay không giữ transaction hay làm cạn pool.

#### Rủi ro kysely rollback-release còn lại

Task 19 xác minh kysely 0.29.6 `ControlledTransaction.rollback()` và `commit()` gọi driver trước rồi mới release; khi driver ném lỗi, release bị bỏ qua vì không có finally. Cùng đường code được thấy ở 0.30.0-beta.2 tại thời điểm báo cáo. MikroORM transactional chỉ log cảnh báo khi rollback thất bại. `TransactionBuilder.execute` và `DefaultConnectionProvider` có finally, không mắc đường lỗi này.

Không fork hoặc vá dependency. Lease loại bỏ tác nhân đã biết ở relay; transaction khác mất connection giữa chừng (failover, mạng, terminate backend) vẫn có thể rò client. Dấu hiệu: pool không phục vụ thêm và shutdown kẹt ở pool.end.

```js
rollback() {
  return new Command(async () => {
    await this.#props.driver.rollbackTransaction(this.#props.connection.connection);
    this.#state.isRolledBack = true;
    this.#props.connection.release();   // bị bỏ qua khi ROLLBACK ném lỗi
  });
}
```

**Issue upstream: chưa gửi, người dùng quyết định có gửi hay không.** Nội dung đã soạn sẵn (tiếng Anh, để dán lên GitHub của kysely):

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

Có thể gửi thêm một issue tuỳ chọn cho MikroORM: `AbstractSqlConnection.transactional` nên huỷ connection khi rollback thất bại, thay vì chỉ log cảnh báo.

### Cron, lịch tenant và retention

Cron tĩnh `defineCron` đọc lịch từ config và đồng bộ qua BullMQ Job Scheduler; chỉ xoá bằng `retireCron`, không xoá vì worker hiện tại không biết cron (rolling deploy). Tenant schedule trong `scheduled_tasks` có RLS; reconciler đọc bằng quyền SELECT riêng của relay.

Tenant chỉ chọn job `tenantSchedulable`, mang org trong meta, kiểm tra key/timezone/chu kỳ tối thiểu. cron-parser không có API minimum gap: chọn grid giờ×phút để tính cận dưới, rồi kiểm tra prev/next quanh chuyển UTC offset trong 366 ngày. Lấy mẫu vài lần có thể bỏ sót lịch dồn; duyệt cả năm quá đắt trên request path. Parser lỗi hoặc trả thời điểm không tăng thì từ chối 422. Tên timezone giữ như đầu vào, chỉ sửa khác biệt hoa/thường, tránh ICU đổi sang alias cũ.

Retention so sánh sau khi quy đổi cùng đơn vị:
- thời gian giữ outbox > thời gian giữ failed job;
- thời gian giữ inbox > thời gian giữ outbox + thời gian giữ failed job.

Bull Board đã bỏ khỏi SP1; triển khai SP2 sau RBAC admin, chỉ đọc và cổng nội bộ.

### Chuẩn hoá: follow-up SP1 (SP2 Task 47)

| Bảng | Follow-up | Quyết định | Lý do |
|---|---|---|---|
| `scheduled_tasks` | `job_name` là chuỗi tự do | **Sửa:** `CHECK (job_name ~ '^[a-z][a-z0-9._-]*$')` (đúng `NAME_PATTERN` của `defineJob`) | Enum/định danh không được là chuỗi tự do; tập job đổi theo code của nhiều module nên chỉ ép định dạng ở DB, tập hợp ở app (`findJob` lúc reconcile) |
| `scheduled_tasks` | `timezone` chỉ validate ở app | **Chấp nhận, ghi lý do** | Tập IANA đổi theo bản tzdata; liệt kê trong `CHECK` thì mỗi lần nâng tzdata phải viết migration; `normalizeTimezone` validate lúc ghi |
| `outbox_events` | `type` → `aggregate_type`? | **Chấp nhận: không có phụ thuộc hàm** | Quy ước `context.aggregate.verb` là quy ước đặt tên, không ràng buộc: `notifications.delivery.failed` có aggregate `email_delivery` (Task 20). Không có FD nên không vi phạm 3NF; dòng outbox là snapshot bất biến |
| `processed_events` | `processed_at` = `created_at` | **Chấp nhận tới lần sửa bảng kế tiếp** | Bỏ cột trên bảng đang chạy cần expand → contract qua hai release (code dọn inbox đang dùng `processed_at` + index của nó); giá trị thấp, không có dị thường cập nhật (bảng chỉ INSERT/DELETE) |

## Cập nhật SP2 (2026-09-27)

`email_deliveries` dùng PENDING → SENDING → SENT/FAILED; claim đặt lease với `lease_owner` UUIDv7 mới, mọi complete/release/fail đều có fencing theo owner. Reconcile tăng generation bền và enqueue job `<public_id>-g<n>`; SMTP chạy ngoài transaction. `Message-ID` cố định hỗ trợ dedup của mail server, không bảo đảm exactly-once: SMTP nhận thư rồi worker chết trước SENT có thể gửi lặp.

Chuẩn hoá (§5.16c SP2): khoá ứng viên `id`, `public_id`, `idempotency_key`; mỗi khoá xác định mọi cột còn lại, BCNF. `lease_owner` là khoá ứng viên từng phần khi khác NULL, được DB ép UNIQUE; `idempotency_key` xác định template qua CHECK tiền tố. recipient_enc là snapshot bất biến, grant UPDATE theo cột giữ tính nhất quán. State/template/locale/error code và bộ lease được CHECK; SENDING tương đương có đủ owner/until, trạng thái cuối tương đương có `completed_at`, và `params_enc IS NULL` tương đương trạng thái cuối. Ngoài PENDING phải có attempts > 0; attempts/generation không âm. Dữ liệu recipient/params mã hoá theo public_id sinh ở app, xoá params ở terminal state. S2-R42 đã thêm template `change-email-confirmation` vào CHECK của migration chưa phát hành; dev DB chạy bản cũ phải reset rồi migrate lại.

`OutboxWriter.append(..., { ifAbsent: true })` và `EventPublisher.publish(def, { eventId, ... }, { ifAbsent: true })` cho phép event id xác định. `identity.user.registered` dùng v5 và marker `registered_event_emitted_at`: ghi outbox idempotent rồi mới đánh dấu, cron bù khoảng trống giữa hai pool. **`ON CONFLICT DO NOTHING` không có conflict target**: cùng eventId nhưng payload khác bị hấp thụ im lặng có chủ đích; caller phải bảo đảm payload nhất quán. Thêm UNIQUE/exclusion constraint mới trên `outbox_events` có thể khiến xung đột khác cũng bị bỏ qua; phải rà lại câu INSERT và test trước khi thêm (carry-forward Task 12).

S2-R61: outage SMTP vượt `NOTIFICATIONS_MAX_TOTAL_ATTEMPTS` kết thúc FAILED và phát `notifications.delivery.failed`; reconcile không resend FAILED. Trong retry budget, cron phục hồi job kẹt; ngoài budget người dùng phải yêu cầu thư mới. Follow-up chuẩn hoá SP1 của Task 47 ở mục trên giữ nguyên.

## Phương án đã loại

`@nestjs/bullmq` với Processor tĩnh không phù hợp worker tạo từ config. Gửi event trong bộ nhớ hoặc gọi Redis trong transaction không bền vững. Giữ row lock qua I/O ngoài đã gây lỗi thực tế. Không dựa riêng vào jobId để chống trùng vĩnh viễn.

## Hệ quả và vận hành

Giao ít nhất một lần, xử lý DB chống lặp bằng inbox; provider ngoài vẫn cần idempotency. `outbox_parked_events > 0` cần điều tra log, schema và phiên bản consumer; không tự reset hàng loạt attempts hoặc xoá inbox. Sau khi sửa nguyên nhân, cần phương án replay có kiểm soát, bảo toàn eventId/jobId và kiểm tra side effect đã xảy ra. Công cụ replay/admin đầy đủ: Chưa quyết, xem sub-project 6.

Cron tĩnh dùng cùng kiểm tra DST với lịch tenant (`minGapSec`): cron mà cron-parser không tính được quanh một lần đổi offset (BullMQ nuốt lỗi nên lịch lặng lẽ không chạy) làm `StaticScheduler.sync` ném lỗi lúc worker boot, trước khi upsert cron nào. Ngân sách shutdown tính riêng thời gian stop relay (`OUTBOX_ENQUEUE_TIMEOUT_MS`, xem ADR 0014); dù process bị giết giữa chừng, dữ liệu vẫn được bảo vệ bởi lease. PgBouncer dùng image edoburu pin digest; app qua PgBouncer, relay/migration thẳng Postgres.

## Nguồn

Spec SP1 §5.4–5.7; review trước thực thi §2 và quyết định đã chốt; R3, R9–R13, R22; báo cáo Task 8–11, 16, 19 và `task-19-relayfix-report.md` (gồm Fix round 1). Xem thêm [ADR RLS](0005-multi-tenant-rls.md), [ADR HTTP](0007-http-conventions.md).
