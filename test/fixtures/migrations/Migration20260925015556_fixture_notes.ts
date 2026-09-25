import { Migration } from '@mikro-orm/migrations';

export class Migration20260925015556_fixture_notes extends Migration {
  override name = 'Migration20260925015556_fixture_notes';

  override up(): void | Promise<void> {
    this.addSql(`CREATE TABLE fixture_notes (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    body TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now());`);
    // Dùng bởi FixtureRepo.countSystemNotes (WHERE body = ?).
    this.addSql(`CREATE INDEX fixture_notes_body_idx ON fixture_notes (body);`);
    this.addSql(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON fixture_notes TO app_user;`,
    );
  }

  override down(): void | Promise<void> {
    this.addSql(`DROP TABLE fixture_notes;`);
  }
}
