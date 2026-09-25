import { Migration } from '@mikro-orm/migrations';

/**
 * Bảng hạ tầng không bật RLS: `app_user` chỉ INSERT được outbox và inbox (không đọc được dòng
 * nào của org nào; `Inbox.once` dùng `RETURNING 1`); payload mọi org chỉ `app_relay` (worker)
 * đọc được. Không role nào có BYPASSRLS.
 */
export class Migration20260925032035_outbox_inbox extends Migration {
  override name = 'Migration20260925032035_outbox_inbox';

  override up(): void | Promise<void> {
    this.addSql(`CREATE TABLE outbox_events (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id UUID NOT NULL UNIQUE,
    type TEXT NOT NULL,
    version INT NOT NULL CHECK (version > 0),
    org_id UUID NULL,
    aggregate_type TEXT NOT NULL,
    aggregate_id TEXT NOT NULL,
    aggregate_version BIGINT NOT NULL,
    payload JSONB NOT NULL,
    headers JSONB NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_at TIMESTAMPTZ NULL,
    publish_attempts INT NOT NULL DEFAULT 0 CHECK (publish_attempts >= 0),
    -- Lease của relay đã claim dòng (R22): hết hạn thì relay khác claim lại được. NULL = chưa ai giữ.
    claimed_until TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now());`);
    // Relay claim: WHERE published_at IS NULL AND publish_attempts < max
    //   AND (claimed_until IS NULL OR claimed_until < now()) ORDER BY id LIMIT n FOR UPDATE SKIP LOCKED.
    // Duyệt theo id trên đúng tập chưa publish rồi lọc hai điều kiện còn lại trên heap. Không đưa
    // chúng vào index: `now()` không IMMUTABLE nên không vào được predicate; max attempts là
    // config; FOR UPDATE luôn phải đọc heap để khoá dòng nên INCLUDE không giúp gì. Dòng bị bỏ qua
    // chỉ là dòng đang được lease (≤ số relay × batch) và dòng đã park. Metric outbox_lag cũng chỉ
    // đọc tập chưa publish này (dòng đang được lease vẫn tính vào lag: chưa publish là còn trễ).
    this.addSql(
      `CREATE INDEX outbox_events_unpublished_idx ON outbox_events (id) WHERE published_at IS NULL;`,
    );
    // Cleanup (Task 11): xoá dòng đã publish quá hạn giữ.
    this.addSql(
      `CREATE INDEX outbox_events_published_at_idx ON outbox_events (published_at) WHERE published_at IS NOT NULL;`,
    );
    this.addSql(`CREATE TABLE processed_events (
    consumer TEXT NOT NULL,
    event_id UUID NOT NULL,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- PK tự nhiên thay cho BIGINT identity: chính nó là khoá chống trùng của Inbox.once (INSERT ... ON CONFLICT DO NOTHING).
    PRIMARY KEY (consumer, event_id));`);
    // Cleanup (Task 11): xoá bản ghi inbox quá hạn giữ.
    this.addSql(
      `CREATE INDEX processed_events_processed_at_idx ON processed_events (processed_at);`,
    );
    this.addSql(`GRANT INSERT ON outbox_events TO app_user;`);
    this.addSql(`GRANT SELECT, UPDATE, DELETE ON outbox_events TO app_relay;`);
    this.addSql(`GRANT INSERT ON processed_events TO app_user;`);
    this.addSql(`GRANT SELECT, DELETE ON processed_events TO app_relay;`);
  }

  override down(): void | Promise<void> {
    this.addSql(`DROP TABLE processed_events;`);
    this.addSql(`DROP TABLE outbox_events;`);
  }
}
