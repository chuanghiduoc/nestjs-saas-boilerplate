# 0014 - Observability: OpenTelemetry, trace xuyên outbox/job, metric, tắt êm

- Status: accepted
- Date: 2026-09-25

## Decision

### Export bằng OTLP/HTTP, SDK khởi động trước app

- `@opentelemetry/sdk-node` + `@opentelemetry/auto-instrumentations-node`, export trace và metric bằng OTLP/HTTP tới `OTEL_EXPORTER_OTLP_ENDPOINT` (`/v1/traces`, `/v1/metrics`). Collector (Task 19) chuyển tiếp tới backend.
- `src/instrumentation.ts` được nạp bằng `node --import ./dist/instrumentation.js dist/main.<role>.js` (script `start:api`/`start:worker`). App là ESM nên file này gọi `module.register('@opentelemetry/instrumentation/hook.mjs', import.meta.url)` (hook của import-in-the-middle, theo README của import-in-the-middle và `doc/esm-support.md` của opentelemetry-js), chỉ khi `OTEL_ENABLED=true`. Không cần thêm `--experimental-loader`. `CMD` của Dockerfile phải dùng đúng lệnh của script.
- Log không gửi qua OTLP: stdout (pino, đã redact) là đường log duy nhất. `logRecordProcessors: []` để NodeSDK không tự tạo exporter log theo env; instrumentation pino chỉ gắn `trace_id`/`span_id`.
- Tắt instrumentation `fs`, `dns`, `net` (trace gốc cho mỗi lần mở connection, không thêm giá trị). `ioredis`, `pg` bật `requireParentSpan`: lệnh nền (BullMQ poll, relay outbox) không tạo trace gốc, chỉ ghi span khi nằm trong request/job.

### Config OTel độc lập với `APP_ROLE`

`otelConfig` (`OTEL_ENABLED`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME`, `OTEL_TRACES_SAMPLE_RATIO`, `OTEL_METRICS_INTERVAL_MS`) không đọc `appConfig`, vì `instrumentation.ts` chạy trước khi entrypoint đặt `APP_ROLE`. Tắt OTel (mặc định, và trong test) thì API OTel là no-op.

### Lấy mẫu

- Head sampling `OTEL_TRACES_SAMPLE_RATIO` (mặc định 10%): `ParentBasedSampler` với `root`, `remoteParentSampled`, `remoteParentNotSampled` đều là `TraceIdRatioBasedSampler`. `traceparent` do client gửi không ép được lấy mẫu 100%: parent từ xa bị lấy mẫu lại theo ratio.
- Job/event dùng `traceparent` trong meta làm parent từ xa. Ratio sampler quyết định theo trace id, nên job cùng trace nhận đúng quyết định của request gốc.
- "Giữ 100% trace lỗi" làm bằng tail sampling ở collector, không làm trong app.

### Trace xuyên HTTP → outbox → relay → job → deliver: một cơ chế duy nhất

- Carrier là chuỗi W3C `traceparent` trong `JobMeta` (và header `traceparent` của dòng outbox, envelope event). `EventPublisher` ghi `currentTraceparent()`; relay chép header vào meta job dispatch; dispatch chép sang job deliver/deferred; `BullmqJobQueue` chỉ điền `currentTraceparent()` khi caller không truyền. `WorkerHost` chạy handler trong `withRemoteParent(meta.traceparent, 'job <name>')`, bên trong `RequestContext.run` và `OrgScope.run`, rồi đặt `traceId` vào context (log của handler mang trace id).
- `ContextModule` đặt `traceId`/`traceparent` từ span HTTP đang active; header `traceparent` của client chỉ vào context qua propagator của OTel, không copy thẳng.
- Đã loại `bullmq-otel`: nó tự propagate context qua `opts.telemetry.metadata` của job, không đi qua được outbox (dòng DB, relay poll không có context của request) và `addBulk` của relay sẽ gắn context của relay cho mọi job trong lô. Dùng cả hai là propagate hai lần với hai parent khác nhau. Giữ một cơ chế (meta) chạy được cho mọi đường: enqueue trực tiếp, outbox, deferred job.

### Metric

- `outbox_lag_seconds`: tuổi dòng outbox chưa publish cũ nhất, đọc bằng `RelayDb` (role `app_relay`), **bỏ qua dòng đã park** (`publish_attempts >= OUTBOX_MAX_PUBLISH_ATTEMPTS`): tính vào thì một dòng hỏng ghim gauge tăng mãi và che độ trễ thật; dòng park đã được relay log `error`.
- `queue_depth{queue}`, `queue_oldest_job_age_seconds{queue}`: qua `JobQueue.stats()` (`getJobCounts('waiting')` + `getJobs(['waiting'], 0, 0, true)` của BullMQ). Tuổi tính từ lúc job đủ điều kiện chạy: `max(timestamp + opts.delay, processedOn)`, vì BullMQ đặt lại field `delay` = 0 khi promote job delayed (job của scheduler sẽ bị tính dư cả khoảng delay nếu chỉ dùng `timestamp`).
- `queue_failed_total{queue}`: counter, `WorkerHost` tăng trong `worker.on('failed')` (mỗi lần thử thất bại).
- Gauge là observable (callback), chỉ chạy khi reader thu thập mỗi `OTEL_METRICS_INTERVAL_MS`, nên tải Redis/DB bị chặn theo chu kỳ này. Chỉ worker đăng ký (`ObservabilityModule.forRoot({ worker: true })`). Callback lỗi: log `warn`, bỏ lần đo. Callback được gỡ ở `onModuleDestroy`, trước khi DB/Redis đóng.
- Không gắn attribute có quá nhiều giá trị (org id, job id, request id): chỉ tên queue.

### Tắt êm

`installShutdown(app)`: SIGTERM/SIGINT → `app.close()` → `shutdownTelemetry()` (flush **sau** `app.close()` để span/metric của giai đoạn tắt cũng được gửi) → exit 0; lỗi → log, exit 1. Hạn chót cứng `APP_SHUTDOWN_TIMEOUT_MS` (mặc định 28s): quá hạn (handler bỏ qua abort nên WorkerHost bỏ worker, `OutboxRelay.stop()` chờ lô treo, collector không phản hồi) thì log lỗi và exit 1, trước SIGKILL của Kubernetes (grace mặc định 30s). Config rule `shutdown-budget` bắt `APP_SHUTDOWN_TIMEOUT_MS > QUEUE_SHUTDOWN_TIMEOUT_MS + QUEUE_SHUTDOWN_ABORT_GRACE_MS` (mặc định 20s + 5s).

### Package

`@opentelemetry/sdk-metrics` không cài riêng: dùng re-export `metrics` của `@opentelemetry/sdk-node`. `@opentelemetry/sdk-trace-base` vẫn cài riêng vì re-export `tracing` của sdk-node đã deprecated. `@opentelemetry/instrumentation` là dependency trực tiếp vì `instrumentation.ts` đăng ký `hook.mjs` của nó.
