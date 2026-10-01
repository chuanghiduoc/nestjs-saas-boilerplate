import { Migration } from '@mikro-orm/migrations';
import type { MigrationObject } from '../../src/core/database/index.js';

/**
 * Spec SP3 §8.8 bước 2: tập bảng mà DML, trigger và câu dựng event của migration catalogue chạm tới, thứ tự cố định (thứ tự
 * lấy ACCESS EXCLUSIVE luôn giống nhau). Bảng của 3D chưa có ở 3B thì bị bỏ qua (`to_regclass`).
 */
export const CATALOGUE_DATA_TABLES = [
  'org_roles',
  'org_role_permissions',
  'org_api_keys',
  'org_api_key_permissions',
  'org_support_grants',
  'org_support_grant_permissions',
] as const;

const eachTable = (
  mode: 'NO FORCE' | 'FORCE',
): string => `DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY[${CATALOGUE_DATA_TABLES.map((t) => `'${t}'`).join(', ')}] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I ${mode} ROW LEVEL SECURITY', t);
    END IF;
  END LOOP;
END $$;`;

/** Bước 4: tên deferrable phải duy nhất theo schema (R4C-N4-4, R5-C1), rồi xả trigger hoãn THEO TÊN (không bao giờ `ALL`, R3-DB-2). */
const FLUSH_DEFERRED = `DO $$ DECLARE r record; BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE n.nspname IN ('public', 'auth') GROUP BY c.connamespace, c.conname HAVING count(*) > 1 AND bool_or(c.condeferrable)
  ) THEN
    RAISE EXCEPTION 'a deferrable constraint name must be unique per schema';
  END IF;
  FOR r IN SELECT n.nspname, c.conname FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
           WHERE c.condeferrable AND n.nspname IN ('public', 'auth') LOOP
    EXECUTE format('SET CONSTRAINTS %I.%I IMMEDIATE', r.nspname, r.conname);
  END LOOP;
END $$;`;

/** Bước 5: trả từng constraint deferrable về chế độ khai báo (không rò `IMMEDIATE` sang migration sau, CDX-4). */
const RESTORE_DECLARED = `DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT n.nspname, c.conname, c.condeferred FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
           WHERE c.condeferrable AND n.nspname IN ('public', 'auth') LOOP
    EXECUTE format('SET CONSTRAINTS %I.%I %s', r.nspname, r.conname, CASE WHEN r.condeferred THEN 'DEFERRED' ELSE 'IMMEDIATE' END);
  END LOOP;
END $$;`;

/** Bước 7: cùng khối khẳng định với migration 3A/3B (chuỗi RAISE là hằng mà `migration-scan.spec.ts` tìm). */
const ASSERT_FORCE = `DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relrowsecurity AND NOT c.relforcerowsecurity
      AND (c.relname = 'organizations' OR EXISTS (
        SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'org_id' AND a.attnum > 0 AND NOT a.attisdropped))
  ) THEN
    RAISE EXCEPTION 'a tenant table lost FORCE ROW LEVEL SECURITY';
  END IF;
END $$;`;

export function sevenStep(
  dml: readonly string[],
  opts: { skipForceRestore?: boolean } = {},
): string[] {
  return [
    eachTable('NO FORCE'),
    ...dml,
    FLUSH_DEFERRED,
    RESTORE_DECLARED,
    ...(opts.skipForceRestore ? [] : [eachTable('FORCE')]),
    ASSERT_FORCE,
  ];
}

/**
 * Bước 3 cho role (spec §8.8, dòng "Xoá" và "Thêm cạnh requires"): mọi tập đã lưu thu hẹp tới điểm bất động — lặp xoá quyền
 * có ít nhất một quyền yêu cầu trực tiếp không nằm trong tập, tới khi một vòng không xoá gì (quyền phụ thuộc BẮC CẦU cũng bị
 * gỡ). Mỗi role bị chạm: `version + 1` và đúng một `tenancy.role.updated` dựng từ giá trị SAU khi tăng. Vòng đời không bao
 * giờ mở rộng quyền.
 */
export function narrowRolesToFixpoint(
  migration: string,
  initialDelete?: string,
): string {
  const actor = `catalogue-migration:${migration}`;
  return `DO $$
DECLARE v_removed bigint;
BEGIN
  DROP TABLE IF EXISTS pg_temp.catalogue_touched_roles;
  CREATE TEMP TABLE catalogue_touched_roles (org_id uuid NOT NULL, role_id bigint NOT NULL, PRIMARY KEY (org_id, role_id)) ON COMMIT DROP;
  ${
    initialDelete === undefined
      ? ''
      : `WITH d AS (${initialDelete} RETURNING rp.org_id, rp.role_id)
  INSERT INTO catalogue_touched_roles SELECT DISTINCT org_id, role_id FROM d ON CONFLICT DO NOTHING;`
  }
  LOOP
    WITH d AS (
      DELETE FROM public.org_role_permissions rp
      WHERE EXISTS (
        SELECT 1 FROM public.permission_requires r
        WHERE r.permission_id = rp.permission_id
          AND NOT EXISTS (SELECT 1 FROM public.org_role_permissions x
                          WHERE x.org_id = rp.org_id AND x.role_id = rp.role_id AND x.permission_id = r.required_permission_id))
      RETURNING rp.org_id, rp.role_id),
    i AS (INSERT INTO catalogue_touched_roles SELECT DISTINCT org_id, role_id FROM d ON CONFLICT DO NOTHING)
    SELECT count(*) INTO v_removed FROM d;
    EXIT WHEN v_removed = 0;
  END LOOP;
  WITH u AS (
    UPDATE public.org_roles r SET version = r.version + 1, updated_at = now()
    FROM catalogue_touched_roles t WHERE r.org_id = t.org_id AND r.id = t.role_id
    RETURNING r.org_id, r.id, r.public_id, r.version)
  INSERT INTO public.outbox_events (event_id, type, version, org_id, aggregate_type, aggregate_id, aggregate_version, payload, headers)
  SELECT uuidv7(), 'tenancy.role.updated', 1, u.org_id, 'role', u.public_id::text, u.version,
    jsonb_build_object('roleId', u.public_id, 'permissions', COALESCE((
      SELECT jsonb_agg(p.key ORDER BY p.key) FROM public.org_role_permissions rp JOIN public.permissions p ON p.id = rp.permission_id
      WHERE rp.org_id = u.org_id AND rp.role_id = u.id AND p.deprecated_at IS NULL), '[]'::jsonb)),
    jsonb_build_object('actorType', 'system', 'actorId', '${actor}', 'correlationId', '${actor}')
  FROM u;
END $$;`;
}

/** Dòng vòng đời "Xoá (bản N+1)": quyền đã deprecate ở bản N; gỡ khỏi mọi tập, thu hẹp, rồi cạnh `requires`, rồi dòng catalogue. */
export function removePermissionDml(migration: string, key: string): string[] {
  const id = `(SELECT id FROM public.permissions WHERE key = '${key}')`;
  return [
    narrowRolesToFixpoint(
      migration,
      `DELETE FROM public.org_role_permissions rp USING public.permissions p WHERE p.id = rp.permission_id AND p.key = '${key}'`,
    ),
    `DELETE FROM public.permission_requires WHERE permission_id = ${id} OR required_permission_id = ${id};`,
    `DELETE FROM public.permissions WHERE key = '${key}';`,
  ];
}

/** Dòng vòng đời "Thêm cạnh requires P → Q": chèn cạnh TRƯỚC, rồi thu hẹp mọi tập (không bù Q). */
export function addRequiresEdgesDml(
  migration: string,
  edges: readonly (readonly [string, string])[],
): string[] {
  return [
    `INSERT INTO public.permission_requires (permission_id, required_permission_id)
     SELECT p.id, q.id FROM (VALUES ${edges.map(([from, to]) => `('${from}', '${to}')`).join(', ')}) AS e (k, req)
     JOIN public.permissions p ON p.key = e.k JOIN public.permissions q ON q.key = e.req;`,
    narrowRolesToFixpoint(migration),
  ];
}

/** Migration fixture chỉ đi tới (không bao giờ `down`), tên đúng dạng `Migration<14 chữ số>_<tên>` của runner. */
export function catalogueMigration(
  name: string,
  statements: readonly string[],
): MigrationObject {
  class CatalogueFixtureMigration extends Migration {
    override up(): void {
      for (const s of statements) this.addSql(s);
    }
    override down(): void {
      throw new Error(`${name} is a forward-only test migration`);
    }
  }
  Object.defineProperty(CatalogueFixtureMigration, 'name', { value: name });
  return { name, class: CatalogueFixtureMigration };
}
