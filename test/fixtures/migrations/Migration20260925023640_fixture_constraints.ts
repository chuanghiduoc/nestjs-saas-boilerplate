import { Migration } from '@mikro-orm/migrations';

export class Migration20260925023640_fixture_constraints extends Migration {
  override name = 'Migration20260925023640_fixture_constraints';

  override up(): void | Promise<void> {
    this.addSql(`CREATE TABLE fixture_parents (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    counter INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now());`);
    this.addSql(`CREATE TABLE fixture_children (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    parent_id BIGINT NOT NULL REFERENCES fixture_parents (id) ON DELETE RESTRICT,
    email TEXT NOT NULL,
    qty INT NOT NULL CONSTRAINT fixture_children_qty_positive CHECK (qty > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT fixture_children_email_uq UNIQUE (email));`);
    // Dùng bởi kiểm tra FK khi xoá fixture_parents (FixtureRepo.deleteParent).
    this.addSql(
      `CREATE INDEX fixture_children_parent_id_idx ON fixture_children (parent_id);`,
    );
    this.addSql(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON fixture_parents, fixture_children TO app_user;`,
    );
    // Cố ý không GRANT: 42501 không phải RLS thì không được map thành 404.
    this.addSql(
      `CREATE TABLE fixture_no_grant (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());`,
    );
  }

  override down(): void | Promise<void> {
    this.addSql(`DROP TABLE fixture_no_grant;`);
    this.addSql(`DROP TABLE fixture_children;`);
    this.addSql(`DROP TABLE fixture_parents;`);
  }
}
