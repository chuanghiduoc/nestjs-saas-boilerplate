import { Migration } from '@mikro-orm/migrations';

export class Migration20260925023638_fixture_org_notes extends Migration {
  override name = 'Migration20260925023638_fixture_org_notes';

  override up(): void | Promise<void> {
    this.addSql(`CREATE TABLE fixture_org_notes (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    org_id UUID NOT NULL,
    body TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now());`);
    // Dùng bởi policy RLS (org_id = app_current_org()) + FixtureRepo.listOrgBodies (ORDER BY id).
    this.addSql(
      `CREATE INDEX fixture_org_notes_org_id_idx ON fixture_org_notes (org_id, id);`,
    );
    // Mẫu chuẩn cho mọi bảng tenant: RLS + FORCE + policy dùng app_current_org() (fail-closed).
    this.addSql(`ALTER TABLE fixture_org_notes ENABLE ROW LEVEL SECURITY;`);
    this.addSql(`ALTER TABLE fixture_org_notes FORCE ROW LEVEL SECURITY;`);
    this.addSql(`CREATE POLICY fixture_org_notes_isolation ON fixture_org_notes
    USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());`);
    this.addSql(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON fixture_org_notes TO app_user;`,
    );
  }

  override down(): void | Promise<void> {
    this.addSql(`DROP TABLE fixture_org_notes;`);
  }
}
