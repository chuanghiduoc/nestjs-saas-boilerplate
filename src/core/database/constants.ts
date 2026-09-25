export const DB_CONTEXT = { app: 'app', relay: 'relay' } as const;
/** Tên biến session Postgres mang org hiện tại. Trùng với hàm SQL app_current_org() trong migration core_bootstrap. */
export const ORG_SESSION_VAR = 'app.org_id';
export const CORE_MIGRATIONS_TABLE = 'mikro_orm_migrations';
export const FIXTURE_MIGRATIONS_TABLE = 'mikro_orm_migrations_fixtures';
export const DIST_MIGRATIONS = {
  path: 'dist/migrations',
  glob: '**/*.js',
} as const;
