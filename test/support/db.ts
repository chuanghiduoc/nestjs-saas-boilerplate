import { getInfra, type Infra } from './infra.js';

/** Env của config `database` trỏ vào hạ tầng test: connection `app` đi qua PgBouncer (giống production), `relay`/owner đi thẳng Postgres. */
export function dbEnvFor(infra: Infra): Record<string, string> {
  const { pg, pgbouncer } = infra;
  return {
    DB_HOST: pgbouncer.host,
    DB_PORT: String(pgbouncer.port),
    DB_NAME: pg.database,
    DB_APP_USER: pg.app.user,
    DB_APP_PASSWORD: pg.app.password,
    DB_RELAY_HOST: pg.host,
    DB_RELAY_PORT: String(pg.port),
    DB_RELAY_USER: pg.relay.user,
    DB_RELAY_PASSWORD: pg.relay.password,
    DB_OWNER_USER: pg.owner.user,
    DB_OWNER_PASSWORD: pg.owner.password,
  };
}

export function dbEnv(): Record<string, string> {
  return dbEnvFor(getInfra());
}
