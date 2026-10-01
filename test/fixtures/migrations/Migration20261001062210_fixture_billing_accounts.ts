import { Migration } from '@mikro-orm/migrations';

/**
 * Vai `billing_accounts` của SP5 (spec SP4 PA-14, PA-15): khoá của caller đứng TRƯỚC `org_entitlements` trong thứ tự khoá
 * toàn hệ thống (§3.6). Không FK tới `organizations` (như S5-D4: account sống qua purge), không cột `org_id` (bảng global).
 */
export class Migration20261001062210_fixture_billing_accounts extends Migration {
  override name = 'Migration20261001062210_fixture_billing_accounts';

  override up(): void | Promise<void> {
    this.addSql(`CREATE TABLE fixture_billing_accounts (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    org_ref UUID NOT NULL,
    plan_assignment_seq BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT fixture_billing_accounts_org_ref_uq UNIQUE (org_ref));`);
    this.addSql(
      `GRANT SELECT, INSERT, DELETE ON fixture_billing_accounts TO app_user;`,
    );
    this.addSql(
      `GRANT UPDATE (plan_assignment_seq, updated_at) ON fixture_billing_accounts TO app_user;`,
    );
  }

  override down(): void | Promise<void> {
    this.addSql(`DROP TABLE fixture_billing_accounts;`);
  }
}
