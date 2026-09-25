# 0014 - Observability: OpenTelemetry, trace xuyên outbox/job, metric, tắt êm

- Status: accepted
- Date: 2026-09-25

## Decision

### Export bằng OTLP/HTTP, SDK khởi động trước app

- `@opentelemetry/sdk-node` + `@opentelemetry/auto-instrumentations-node`, export trace và metric bằng OTLP/HTTP tới `OTEL_EXPORTER_OTLP_ENDPOINT` (`/v1/traces`, `/v1/metrics`). Collector (Task 19) chuyển tiếp tới backend.
- `src/instrumentation.ts` được nạp bằng `node --import ./dist/instrumentation.js dist/main.<role>.js` (script `start:api`/`start:worker`). App là ESM nên, khi `OTEL_ENABLED=true`, file này đăng ký hook `import-in-the-middle/hook.mjs` bằng `module.register` kèm kênh `createAddHookMessageChannel()`, rồi `sdk.start()`, rồi `await waitForAllMessagesAcknowledged()` (mẫu trong README của import-in-the-middle; `doc/esm-support.md` của opentelemetry-js hướng tới `module.register`): loader chỉ bọc module mà instrumentation thật sự hook, không bọc mọi module của app. `import-in-the-middle` là dependency trực tiếp (cùng một bản với bản `@opentelemetry/instrumentation` dùng, để kênh message là cùng một instance). Không cần `--experimental-loader`. `CMD` của Dockerfile phải dùng đúng lệnh của script.
- Log không gửi qua OTLP: stdout (pino, đã redact) là đường log duy nhất. `logRecordProcessors: []` để NodeSDK không tự tạo exporter log theo env; instrumentation pino chỉ gắn `trace_id`/`span_id`.
- Tắt instrumentation `fs`, `dns`, `net` (trace gốc cho mỗi lần mở connection, không thêm giá trị). `ioredis`, `pg` bật `requireParentSpan`: lệnh nền (BullMQ poll, relay outbox) không tạo trace gốc, chỉ ghi span khi nằm trong request/job. Hệ quả: trong job, `BEGIN`/`set_config`/`COMMIT` của OrgScope chạy trước khi span job mở nên không được trace (độ trễ commit của job không thấy trong trace).

### Config OTel độc lập với `APP_ROLE`

`otelConfig` (`OTEL_ENABLED`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME`, `OTEL_TRACES_SAMPLE_RATIO`, `OTEL_METRICS_INTERVAL_MS`, `OTEL_EXPORTER_OTLP_TIMEOUT`) không đọc `appConfig`, vì `instrumentation.ts` chạy trước khi entrypoint đặt `APP_ROLE`. Tắt OTel (mặc định, và trong test) thì API OTel là no-op.

### Lấy mẫu

- Head sampling `OTEL_TRACES_SAMPLE_RATIO` (mặc định 10%): `ParentBasedSampler` với `root`, `remoteParentSampled`, `remoteParentNotSampled` đều là `TraceIdRatioBasedSampler`. `traceparent` do client gửi không ép được lấy mẫu 100%: parent từ xa bị lấy mẫu lại theo ratio.
- Job/event dùng `traceparent` trong meta làm parent từ xa. Ratio sampler quyết định theo trace id, nên job cùng trace nhận đúng quyết định của request gốc. Điều kiện: API và worker dùng cùng `OTEL_TRACES_SAMPLE_RATIO`.
- "Giữ 100% trace lỗi" làm bằng tail sampling ở collector, không làm trong app.

### Trace xuyên HTTP → outbox → relay → job → deliver: một cơ chế duy nhất

- Carrier là chuỗi W3C `traceparent` trong `JobMeta` (và header `traceparent` của dòng outbox, envelope event). `EventPublisher` ghi `currentTraceparent()`; relay chép header vào meta job dispatch; dispatch chép sang job deliver/deferred; `BullmqJobQueue` chỉ điền `currentTraceparent()` khi caller không truyền. `WorkerHost` chạy handler trong `withRemoteParent(meta.traceparent, 'job <name>')`, bên trong `RequestContext.run` và `OrgScope.run`, rồi đặt `traceId` vào context (log của handler mang trace id).
- `ContextModule` đặt `traceId`/`traceparent` từ span HTTP đang active; header `traceparent` của client chỉ vào context qua propagator của OTel, không copy thẳng.
- Đã loại `bullmq-otel`: nó tự propagate context qua `opts.telemetry.metadata` của job, không đi qua được outbox (dòng DB, relay poll không có context của request) và `addBulk` của relay sẽ gắn context của relay cho mọi job trong lô. Dùng cả hai là propagate hai lần với hai parent khác nhau. Giữ một cơ chế (meta) chạy được cho mọi đường: enqueue trực tiếp, outbox, deferred job.

### Metric

- `outbox_lag_seconds`: tuổi dòng outbox chưa publish cũ nhất, **bỏ qua dòng đã park** (chưa publish và `publish_attempts >= OUTBOX_MAX_PUBLISH_ATTEMPTS`, đúng điều kiện relay ngừng claim): tính vào thì một dòng hỏng ghim gauge tăng mãi và che độ trễ thật. Dòng park có gauge riêng `outbox_parked_events` (event sẽ không bao giờ được giao, cần người xử lý — nên có alert > 0). Cả hai lấy trong một câu query (`FILTER`) qua `RelayDb` (role `app_relay`).
- `queue_depth{queue}`, `queue_oldest_job_age_seconds{queue}`: qua `JobQueue.stats()` (`getJobCounts('waiting')` + `getJobs(['waiting'], 0, 0, true)` của BullMQ). Tuổi tính từ lúc job đủ điều kiện chạy: `max(timestamp + opts.delay, processedOn)`, vì BullMQ đặt lại field `delay` = 0 khi promote job delayed (job của scheduler sẽ bị tính dư cả khoảng delay nếu chỉ dùng `timestamp`).
- `queue_failed_total{queue}`: counter, `WorkerHost` tăng trong `worker.on('failed')` (mỗi lần thử thất bại).
- Gauge là observable (callback), chỉ chạy khi reader thu thập mỗi `OTEL_METRICS_INTERVAL_MS`, nên tải Redis/DB bị chặn theo chu kỳ này. Chỉ worker đăng ký (`ObservabilityModule.forRoot({ worker: true })`). Callback lỗi: log `warn`, bỏ lần đo. Callback được gỡ ở `onModuleDestroy`, trước khi DB/Redis đóng.
- Không gắn attribute có quá nhiều giá trị (org id, job id, request id): chỉ tên queue.

### Tắt êm

`installShutdown(app)`: SIGTERM/SIGINT → `app.close()` → `shutdownTelemetry()` (flush **sau** `app.close()` để span/metric của giai đoạn tắt cũng được gửi) → exit 0; lỗi → log, exit 1. Handler đăng ký bằng `process.on` và giữ tới khi thoát: signal lặp lại được log và bỏ qua (dùng `once` thì signal thứ hai chạy hành động mặc định và giết process giữa lúc drain khi process không phải PID 1). Hạn chót cứng `APP_SHUTDOWN_TIMEOUT_MS` (mặc định 28s) là timer **ref** (không `unref`: nếu không, `close()` treo trên promise không giữ handle nào làm process tự thoát 0 im lặng); quá hạn thì log lỗi và exit 1, trước SIGKILL của Kubernetes.

Ngân sách (config rule `shutdown-budget`): `APP_SHUTDOWN_TIMEOUT_MS >= QUEUE_SHUTDOWN_TIMEOUT_MS + QUEUE_SHUTDOWN_ABORT_GRACE_MS + APP_SHUTDOWN_RESERVE_MS` và `APP_SHUTDOWN_RESERVE_MS > OTEL_EXPORTER_OTLP_TIMEOUT`. Mặc định 18s drain + 4s abort + 6s dự phòng (≈2–3s đóng DB/Redis/relay + 3s timeout export OTLP cho lần flush cuối) = 28s < 30s grace mặc định. `preStop` sleep của Kubernetes bị trừ vào `terminationGracePeriodSeconds`, nên mặc định 28s giả định không có `preStop`; có thì tăng grace tương ứng.

### Package

`@opentelemetry/sdk-metrics` không cài riêng: dùng re-export `metrics` của `@opentelemetry/sdk-node`. `@opentelemetry/sdk-trace-base` vẫn cài riêng vì re-export `tracing` của sdk-node đã deprecated. `bullmq-otel` không có trong lockfile (chỉ còn là optional peer được khai báo của bullmq, không được resolve).
