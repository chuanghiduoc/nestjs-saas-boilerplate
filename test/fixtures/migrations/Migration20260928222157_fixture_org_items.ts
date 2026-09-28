import { Migration } from '@mikro-orm/migrations';

/**
 * Bảng "nghiệp vụ" giả của `features/` (spec SP3 §18.1): FK RESTRICT tới org như quy ước B5, RLS như mọi bảng tenant.
 * Dùng cho: khoá org không chặn INSERT con (DB-I3), purge quên participant (Task 25), X-5 (Task 24).
 * Index `fixture_org_items_org_idx`: kiểm FK RESTRICT khi xoá `organizations` và lọc RLS `org_id = app_current_org()`.
 */
export class Migration20260928222157_fixture_org_items extends Migration {
  override name = 'Migration20260928222157_fixture_org_items';

  override up(): void | Promise<void> {
    this.addSql(`CREATE TABLE fixture_org_items (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    org_id UUID NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
    body TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now());`);
    this.addSql(
      `CREATE INDEX fixture_org_items_org_idx ON fixture_org_items (org_id);`,
    );
    this.addSql(`ALTER TABLE fixture_org_items ENABLE ROW LEVEL SECURITY;`);
    this.addSql(`ALTER TABLE fixture_org_items FORCE ROW LEVEL SECURITY;`);
    this
      .addSql(`CREATE POLICY fixture_org_items_tenant ON fixture_org_items TO app_user
    USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());`);
    this.addSql(
      `GRANT SELECT, INSERT, DELETE ON fixture_org_items TO app_user;`,
    );
  }

  override down(): void | Promise<void> {
    this.addSql(`DROP TABLE fixture_org_items;`);
  }
}
