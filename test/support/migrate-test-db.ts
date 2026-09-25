import {
  FIXTURE_MIGRATIONS_TABLE,
  runMigrations,
  type MigrationObject,
} from '../../src/core/database/index.js';

type Mod = Record<string, unknown>;
/** Tên lớp do `mikro-orm migration:create` sinh: Migration<14 chữ số timestamp>_<name>. */
const MIGRATION_CLASS_NAME = /^Migration\d{14}_/;

const isMigrationClass = (v: unknown): v is MigrationObject['class'] =>
  typeof v === 'function' && MIGRATION_CLASS_NAME.test(v.name);

function toList(mods: Record<string, Mod>): MigrationObject[] {
  return Object.values(mods)
    .flatMap((m) => Object.values(m).filter(isMigrationClass))
    .map((cls) => ({ name: cls.name, class: cls }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Tên migration = tên lớp = tên file (không đuôi), trùng với tên mà runner `dist` ghi vào bảng theo dõi. */
export const coreMigrationList = (): MigrationObject[] =>
  toList(
    import.meta.glob<Mod>('../../src/migrations/**/*.ts', { eager: true }),
  );
export const fixtureMigrationList = (): MigrationObject[] =>
  toList(import.meta.glob<Mod>('../fixtures/migrations/*.ts', { eager: true }));

function nonEmpty(list: MigrationObject[], what: string): MigrationObject[] {
  if (list.length === 0)
    throw new Error(`No ${what} migrations found by import.meta.glob`);
  return list;
}

export async function migrateTestDb(): Promise<void> {
  await runMigrations('up', {
    source: { kind: 'list', list: nonEmpty(coreMigrationList(), 'core') },
  });
  await runMigrations('up', {
    source: {
      kind: 'list',
      list: nonEmpty(fixtureMigrationList(), 'fixture'),
    },
    tableName: FIXTURE_MIGRATIONS_TABLE,
  });
}
