# 0003 — MikroORM, hai connection và migration có kiểm soát

- Trạng thái: Đã chấp nhận
- Ngày: 2026-09-25

## Bối cảnh

Transaction nghiệp vụ, outbox và session RLS phải dùng cùng EntityManager. API không được có quyền quét dữ liệu mọi tenant; migration cần quyền owner và timeout thực sự có hiệu lực.

## Quyết định

Dùng MikroORM core/postgresql/migrations/cli 7.2.1, tích hợp Nest 7.1.0 (phát hành riêng, peer tương thích với core 7 và Nest 12). Báo cáo Task 5 đã kiểm chứng API trong package cài đặt.

- Context `app`: `app_user`, qua PgBouncer transaction mode; context `relay`: `app_relay`, thẳng Postgres, chỉ worker khởi tạo. Chưa tạo pool admin vì SP1 không có use case.
- `allowGlobalContext: false`, `registerRequestContext: false`. `TxEm` inject theo token có tên, fork với `disableContextResolution: true` rồi gắn vào CLS.
- `UnitOfWork.run` tự fork khi chưa có EM, nhập transaction hiện tại khi đã mở. Chỉ transaction ngoài cùng retry SQLSTATE `40001`/`40P01`; callback có thể chạy lại.
- SQL chỉ qua `Db.execute` (EM đang gắn transaction/session) hoặc `RelayDb`. `SqlEntityManager.execute` nhận placeholder `?`; không dùng `getConnection().execute`.
- Timeout app đặt trên role bằng `ALTER ROLE … SET`; worker dùng `SET LOCAL` trong transaction. Không dùng startup parameters cho app qua PgBouncer.
- Khoá CLS dùng tên phẳng như `core:em`. Tên có dấu chấm làm nestjs-cls tạo object lồng; `ifNested: inherit` sao chép nông khiến EM của context con rò sang cha.
- TLS lấy từ config: `DB_SSL_MODE` = `disable` | `require` | `verify-full` (+ `DB_SSL_CA_PATH`), dùng chung cho app, relay và migrator. Production rule `database-tls` chỉ cấm `disable`. `require` mã hoá nhưng **không** xác minh chứng chỉ (`rejectUnauthorized: false`); chỉ `verify-full` xác minh. Spec SP1 §5.3 yêu cầu production bắt buộc `rejectUnauthorized: true`, nên code hiện tại lỏng hơn spec. Chưa sửa trong task tài liệu này.

### Migration và layout (R7, R8)

Migration chạy bằng `app_owner`, thẳng Postgres qua `DB_MIGRATION_HOST`/`DB_MIGRATION_PORT` riêng; thiếu thì lỗi, không fallback sang địa chỉ app/relay. Runner truyền `lock_timeout`/`statement_timeout` qua pg startup parameters và đọc lại `pg_settings` để xác minh.

Runtime nằm trong `src/`; migration module ở `src/migrations/<module>/`, build ra `dist/migrations/**`. Runner tìm file JavaScript theo `import.meta.url`, import đệ quy rồi truyền `migrationsList` sắp theo tên timestamp. Tên file phải trùng tên subclass Migration. `MigrationObject` export từ `@mikro-orm/core`. Fixture migration dùng bảng theo dõi riêng `mikro_orm_migrations_fixtures`.

Migrations bật `transactional` và `allOrNothing`. `down` bắt buộc target đã chạy; chỉ `down 0` mới revert hết. Đây là guard bắt buộc vì MikroORM có thể revert tất cả khi nhận tên không nằm trong danh sách đã chạy. Revert migration module phụ thuộc trước migration core.

Tạo migration bằng CLI `migration:create`; ngay cả `--blank` cũng cần DB truy cập được. Config CLI riêng; runtime dùng runner đã kiểm soát.

### API đã kiểm chứng (MikroORM 7.2.1 / @mikro-orm/nestjs 7.1.0, đọc trong node_modules)

- `getEntityManagerToken(name)` = `` `${name}_EntityManager` ``; giá trị provider là `orm.em` (EM gốc, lớp runtime `PostgreSqlEntityManager`).
- `@mikro-orm/nestjs` giữ tên context đã đăng ký trong một mảng cấp module và ném `ContextName 'app' already registered` nếu một process đăng ký trùng trước khi `onApplicationShutdown` dọn. Một app mỗi process thì không sao; test phải mở app tuần tự.
- `SqlEntityManager.execute` dùng transaction context của EM và bọc lời gọi trong `withSessionContext` (transaction ngầm ngắn khi có session context mà chưa mở transaction). Tham số dùng placeholder `?`, platform nội suy (`formatQuery`).
- `em.fork()` sao chép session context của EM cha (hoặc nhận `session`); `em.transactional` fork và truyền `sessionContext` cho `begin()`, hàm này chạy `set_config(…, true)` trong transaction. `isolationLevel` nhận chuỗi `'read committed' | 'repeatable read' | 'serializable'`.
- `getContext()` của EM gốc ưu tiên transaction context trong AsyncLocalStorage; fork với `disableContextResolution: true` để không phụ thuộc vào nó.
- Pool: `pool: { min, max }`; `driverOptions` được gộp vào option của `pg.Pool` (`PostgreSqlConnection.mapOptions`), nên `ssl`, `lock_timeout`, `statement_timeout` đặt ở đó; pg gửi timeout trong startup message.
- `MikroORM.init` gộp biến env `MIKRO_ORM_*` dưới option tường minh (option tường minh thắng) và kết nối lười.
- Migrator: `migrations.migrationsList` (`MigrationObject { name, class }`), `tableName`, `orm.migrator.up()/down({ to })/getPending()/getExecuted()`. `down({ to: name })` revert **mọi** migration đã chạy nếu `name` không nằm trong danh sách đã chạy; `down({ to: 0 })` revert tất cả.
- Tên migration là tên file bỏ đuôi, trùng tên class, trùng tên mà discovery file của MikroORM sẽ ghi; runner của app và `migrationsList` của test ghi cùng một dòng.
- Kiểm chứng S4: `node dist/main.migrate.js status|up|down 0|up` với Postgres 18.6, chạy từ thư mục app, từ cwd khác ổ đĩa, và qua `docker compose`.

## Phương án đã loại

Global EM, SQL qua connection thô và role admin trong API phá cô lập transaction/tenant. Migration qua PgBouncer có thể mất startup timeout. Không dùng discovery glob của MikroORM cho layout nhiều thư mục: Task 5 tái hiện đường dẫn sai trên Windows khi cwd khác ổ đĩa.

## Hệ quả

Mỗi process chỉ đăng ký một app cho cùng tên context: tích hợp Nest giữ tên context ở cấp module, nên test API/worker phải tách registry hoặc process. EM fork sao chép session; `sessionContext: transaction` áp session tại BEGIN, kể cả implicit transaction cho một query.

Rủi ro rollback-release của kysely được ghi ở [ADR 0006](0006-queue-outbox.md). Callback transaction không gọi I/O bên ngoài. Cảnh báo peer `tsconfck → typescript ^5` tồn tại từ toolchain; không phải xung đột MikroORM.

## Nguồn

Spec cha §4.2; spec SP1 §4 S4, §5.3; review trước thực thi §2; R7–R8; báo cáo Task 5 (gồm vòng sửa 1), Task 6 và Task 19 relay fix.
