export const DB_CONTEXT = { app: 'app', relay: 'relay' } as const;
/** Tên biến session Postgres mang org hiện tại. Trùng với hàm SQL app_current_org() trong migration core_bootstrap. */
export const ORG_SESSION_VAR = 'app.org_id';
export const CORE_MIGRATIONS_TABLE = 'mikro_orm_migrations';
export const FIXTURE_MIGRATIONS_TABLE = 'mikro_orm_migrations_fixtures';
/**
 * Migration đã build: `dist/core/database/migrator.js` → `dist/migrations/<module>/*.js`.
 * Thư mục tính tương đối với module migrator (import.meta.url), không phụ thuộc cwd.
 */
export const DIST_MIGRATIONS = {
  relativeToMigrator: '../../migrations/',
  extension: '.js',
} as const;
