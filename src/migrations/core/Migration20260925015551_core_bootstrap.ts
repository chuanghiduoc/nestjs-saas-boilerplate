import { Migration } from '@mikro-orm/migrations';

export class Migration20260925015551_core_bootstrap extends Migration {
  override name = 'Migration20260925015551_core_bootstrap';

  override up(): void | Promise<void> {
    // S5: uuidv7() là hàm có sẵn của Postgres 18; migration fail ngay nếu image thiếu nó.
    this.addSql(`SELECT uuidv7();`);
    // Fail-closed: mọi policy RLS dùng hàm này; thiếu org context thì ném lỗi thay vì trả NULL.
    this
      .addSql(`CREATE FUNCTION app_current_org() RETURNS uuid LANGUAGE plpgsql STABLE AS $$
    DECLARE v text := current_setting('app.org_id', true);
    BEGIN
      IF v IS NULL OR v = '' THEN
        RAISE EXCEPTION 'org context is not set' USING HINT = 'run the query inside OrgScope.run';
      END IF;
      RETURN v::uuid;
    END $$;`);
    this.addSql(`REVOKE ALL ON FUNCTION app_current_org() FROM PUBLIC;`);
    this.addSql(
      `GRANT EXECUTE ON FUNCTION app_current_org() TO app_user, app_relay;`,
    );
  }

  override down(): void | Promise<void> {
    this.addSql(`DROP FUNCTION app_current_org();`);
  }
}
