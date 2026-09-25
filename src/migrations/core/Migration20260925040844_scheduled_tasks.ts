import { Migration } from '@mikro-orm/migrations';

/**
 * Lịch của tenant (lịch hệ thống là cron tĩnh `defineCron`, không nằm trong bảng).
 * - `app_user`: đọc/ghi đúng org của mình qua RLS + FORCE (fail-closed bằng `app_current_org()`).
 * - `app_relay` (reconciler trong worker): chỉ SELECT, qua policy riêng `TO app_relay` đọc mọi
 *   org. Policy gắn theo role nên không mở rộng quyền của `app_user` (hai role không kế thừa nhau).
 * Index: UNIQUE (org_id, key) phục vụ upsert/remove theo key trong org và policy RLS; reconciler
 * cần mọi dòng nên quét toàn bảng.
 */
export class Migration20260925040844_scheduled_tasks extends Migration {
  override name = 'Migration20260925040844_scheduled_tasks';

  override up(): void | Promise<void> {
    this.addSql(`CREATE TABLE scheduled_tasks (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    org_id UUID NOT NULL,
    key TEXT NOT NULL CHECK (key ~ '^[a-z0-9._]{1,64}$'),
    job_name TEXT NOT NULL,
    cron TEXT NOT NULL,
    timezone TEXT NOT NULL,
    payload JSONB NOT NULL,
    enabled BOOLEAN NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT scheduled_tasks_org_key_uq UNIQUE (org_id, key));`);
    this.addSql(`ALTER TABLE scheduled_tasks ENABLE ROW LEVEL SECURITY;`);
    this.addSql(`ALTER TABLE scheduled_tasks FORCE ROW LEVEL SECURITY;`);
    this
      .addSql(`CREATE POLICY scheduled_tasks_tenant ON scheduled_tasks TO app_user
    USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());`);
    this.addSql(
      `CREATE POLICY scheduled_tasks_relay_read ON scheduled_tasks FOR SELECT TO app_relay USING (true);`,
    );
    this.addSql(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON scheduled_tasks TO app_user;`,
    );
    this.addSql(`GRANT SELECT ON scheduled_tasks TO app_relay;`);
  }

  override down(): void | Promise<void> {
    // DROP TABLE xoá luôn policy và quyền đã cấp trên bảng.
    this.addSql(`DROP TABLE scheduled_tasks;`);
  }
}
