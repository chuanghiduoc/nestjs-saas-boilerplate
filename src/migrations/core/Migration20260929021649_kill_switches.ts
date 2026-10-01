import { Migration } from '@mikro-orm/migrations';

/**
 * Plan SP6 6.0 (spec SP6 §6.2, §6.9, §6.10). Kill switch vận hành đọc qua OpenFeature (`core/flags`).
 *
 * Bảng chuẩn hoá (spec §6.9):
 * | Bảng | Khoá ứng viên | Phụ thuộc hàm không tầm thường | Dạng |
 * |---|---|---|---|
 * | kill_switches | {key} | — | BCNF (`changed_by` là snapshot người đổi gần nhất — một sự kiện, không phải bản sao bảng user) |
 *
 * Global (không `org_id`, không RLS; `GLOBAL_TABLES` của `rls-catalog.spec.ts`). Chỉ admin (process api) ghi qua
 * `KillSwitches.set`; `app_user` không có `DELETE` (switch bỏ khỏi code thì dòng bị provider bỏ qua, WARN một lần).
 * Index: chỉ PK — provider đọc cả bảng (vài chục dòng), `set` tra theo `key`.
 * Race R6-20 (hai lần đổi đồng thời): CAS `UPDATE … WHERE key = ? AND version = ?` và `INSERT … ON CONFLICT (key) DO NOTHING`.
 * Regex `key` = `KILL_SWITCH_KEY` của `src/core/flags/kill-switch.ts` (migration không import code; test khoá hai phía).
 * Khoá: bảng mới, không khoá bảng có sẵn.
 */
export class Migration20260929021649_kill_switches extends Migration {
  override name = 'Migration20260929021649_kill_switches';

  override up(): void | Promise<void> {
    this.addSql(`CREATE TABLE kill_switches (
    key TEXT PRIMARY KEY,
    killed BOOLEAN NOT NULL,
    reason TEXT NULL,
    changed_by TEXT NOT NULL,
    version INT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT kill_switches_key_ck CHECK (key ~ '^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+$' AND char_length(key) <= 100),
    CONSTRAINT kill_switches_reason_ck CHECK (reason = btrim(reason) AND char_length(reason) BETWEEN 1 AND 500),
    CONSTRAINT kill_switches_reason_required_ck CHECK (NOT killed OR reason IS NOT NULL),
    CONSTRAINT kill_switches_changed_by_ck CHECK (char_length(changed_by) BETWEEN 1 AND 255),
    CONSTRAINT kill_switches_version_ck CHECK (version >= 1));`);
    this.addSql(`GRANT SELECT, INSERT ON kill_switches TO app_user;`);
    this.addSql(
      `GRANT UPDATE (killed, reason, changed_by, version, updated_at) ON kill_switches TO app_user;`,
    );
  }

  override down(): void | Promise<void> {
    this.addSql(`DROP TABLE kill_switches;`);
  }
}
