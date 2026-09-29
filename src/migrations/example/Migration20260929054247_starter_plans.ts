import { Migration } from '@mikro-orm/migrations';

/**
 * Vùng TEMPLATE (spec SP4 S4-D22, §7.7): gói khởi đầu khớp `src/plans.example.ts`. Upstream chạy nó trong CI như mọi
 * migration (migrator đọc đệ quy `dist/migrations/**`); clone nhận bản chép ở `src/migrations/app/<timestamp mới>_starter_plans`
 * lúc `upstream:init` và sửa theo gói thật. Dự án clone mới (chưa có org) chạy backfill trên bảng rỗng: không đổi gì.
 *
 * Mẫu 7 bước SP3 §8.8 trên `ENTITLEMENT_BACKFILL_TABLES = organizations, org_entitlements` (thứ tự cố định): `app_owner` không
 * có policy nào nên dưới FORCE nó thấy 0 org và backfill âm thầm không làm gì. Event: một `entitlements.plan.changed@1` mỗi
 * dòng vừa chèn (CTE `RETURNING`), envelope dựng bằng SQL theo cột `outbox_events`, actor `system`
 * `migration:starter_plans`; test contract parse bằng `parseEnvelope(PlanChangedEvent, …)`. Nếu SP6 6.0 đã lưu cờ
 * `audit`/`webhook` trong cột outbox, câu INSERT ghi đúng cờ của `PlanChangedEvent` (Task 8 Step 4 nhánh B).
 *
 * Khoá: `ACCESS EXCLUSIVE` ngắn trên `organizations` và `org_entitlements` (NO FORCE/FORCE) tới hết lô: chặn câu đường nóng
 * của SP3 §7.3 trong lô. Runbook (README): cửa sổ ít tải, `lock_timeout` của migrator.
 * Down: từ chối khi còn gán `BILLING`/`PLATFORM_ADMIN` (không mất dữ liệu âm thầm); dòng `DEFAULT` dẫn xuất lại được nên xoá.
 */
export class Migration20260929054247_starter_plans extends Migration {
  override name = 'Migration20260929054247_starter_plans';

  override up(): void | Promise<void> {
    this.addSql(`INSERT INTO plans (key) VALUES ('free'), ('pro');`);
    // Bước 2: bỏ FORCE, mỗi bảng một câu, thứ tự cố định.
    this.addSql(
      `ALTER TABLE public.organizations NO FORCE ROW LEVEL SECURITY;`,
    );
    this.addSql(
      `ALTER TABLE public.org_entitlements NO FORCE ROW LEVEL SECURITY;`,
    );
    // Bước 3: DML + event cùng câu (version của aggregate = version sau khi chèn).
    this.addSql(`WITH inserted AS (
  INSERT INTO public.org_entitlements (org_id, plan_id, plan_source, plan_assigned_at)
  SELECT o.id, p.id, 'DEFAULT', now() FROM public.organizations o CROSS JOIN public.plans p WHERE p.key = 'free'
  ON CONFLICT (org_id) DO NOTHING
  RETURNING org_id, version)
INSERT INTO public.outbox_events (event_id, type, version, org_id, aggregate_type, aggregate_id, aggregate_version, payload, headers)
SELECT uuidv7(), 'entitlements.plan.changed', 1, i.org_id, 'org_entitlement', i.org_id::text, i.version,
       jsonb_build_object('orgId', i.org_id, 'fromPlan', NULL, 'toPlan', 'free', 'cause', 'DEFAULT', 'causeRef', NULL),
       jsonb_build_object('actorType', 'system', 'actorId', 'migration:starter_plans', 'correlationId', 'migration:starter_plans')
FROM inserted i;`);
    this.flushDeferredByName();
    this.restoreDeclaredModes();
    // Bước 6: bật lại FORCE, cùng tập, cùng thứ tự.
    this.addSql(`ALTER TABLE public.organizations FORCE ROW LEVEL SECURITY;`);
    this.addSql(
      `ALTER TABLE public.org_entitlements FORCE ROW LEVEL SECURITY;`,
    );
    // Bước 7 (inline: `migration-scan.spec.ts` đòi khối này nằm trong thân `up` sau `NO FORCE` cuối cùng).
    this.addSql(`DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relrowsecurity AND NOT c.relforcerowsecurity
      AND (c.relname = 'organizations' OR EXISTS (
        SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'org_id' AND a.attnum > 0 AND NOT a.attisdropped))
  ) THEN
    RAISE EXCEPTION 'a tenant table lost FORCE ROW LEVEL SECURITY';
  END IF;
END $$;`);
  }

  override down(): void | Promise<void> {
    this.addSql(
      `ALTER TABLE public.organizations NO FORCE ROW LEVEL SECURITY;`,
    );
    this.addSql(
      `ALTER TABLE public.org_entitlements NO FORCE ROW LEVEL SECURITY;`,
    );
    this.addSql(`DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.org_entitlements WHERE plan_source <> 'DEFAULT') THEN
    RAISE EXCEPTION 'organizations have plans assigned by billing or platform staff; reverting the starter plans would lose them';
  END IF;
END $$;`);
    this.addSql(`DELETE FROM public.org_entitlements;`);
    this.flushDeferredByName();
    this.restoreDeclaredModes();
    this.addSql(`ALTER TABLE public.organizations FORCE ROW LEVEL SECURITY;`);
    this.addSql(
      `ALTER TABLE public.org_entitlements FORCE ROW LEVEL SECURITY;`,
    );
    this.addSql(`DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relrowsecurity AND NOT c.relforcerowsecurity
      AND (c.relname = 'organizations' OR EXISTS (
        SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'org_id' AND a.attnum > 0 AND NOT a.attisdropped))
  ) THEN
    RAISE EXCEPTION 'a tenant table lost FORCE ROW LEVEL SECURITY';
  END IF;
END $$;`);
    this.addSql(`DELETE FROM plans WHERE key IN ('free', 'pro');`);
  }

  /** Bước 4: xả trigger hoãn khi `app_owner` còn thấy dòng; tên deferrable phải duy nhất theo schema; không bao giờ `ALL`. */
  private flushDeferredByName(): void {
    this.addSql(`DO $$ DECLARE r record; BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname IN ('public', 'auth')
             GROUP BY c.connamespace, c.conname HAVING count(*) > 1 AND bool_or(c.condeferrable)) THEN
    RAISE EXCEPTION 'a deferrable constraint name must be unique per schema';
  END IF;
  FOR r IN SELECT n.nspname, c.conname FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
           WHERE c.condeferrable AND n.nspname IN ('public', 'auth') LOOP
    EXECUTE format('SET CONSTRAINTS %I.%I IMMEDIATE', r.nspname, r.conname);
  END LOOP;
END $$;`);
  }

  /** Bước 5: trả từng constraint deferrable về chế độ khai báo (không rò sang migration sau trong lô). */
  private restoreDeclaredModes(): void {
    this.addSql(`DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT n.nspname, c.conname, c.condeferred FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
           WHERE c.condeferrable AND n.nspname IN ('public', 'auth') LOOP
    EXECUTE format('SET CONSTRAINTS %I.%I %s', r.nspname, r.conname, CASE WHEN r.condeferred THEN 'DEFERRED' ELSE 'IMMEDIATE' END);
  END LOOP;
END $$;`);
  }
}
