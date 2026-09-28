import pg from 'pg';
import { getContainerRuntimeClient } from 'testcontainers';
import { getInfra, type Creds } from './infra.js';

/** Tên database chỉ gồm chữ thường, số, `_` (không cần quote trong SQL của `exec`). */
const NAME = /^[a-z][a-z0-9_]{0,62}$/;
const INIT_SCRIPT = '/docker-entrypoint-initdb.d/01-roles.sh';

async function execInPg(cmd: string): Promise<string> {
  const runtime = await getContainerRuntimeClient();
  const container = runtime.container.getById(getInfra().pg.containerId);
  const r = await runtime.container.exec(container, ['bash', '-c', cmd]);
  if (r.exitCode !== 0)
    throw new Error(`docker exec failed (${r.exitCode}): ${r.output}`);
  return r.output;
}

export type ScratchDb = {
  name: string;
  client(role: 'owner' | 'app' | 'auth'): Promise<pg.Client>;
  drop(): Promise<void>;
};

/**
 * Database riêng cho test migration (spec SP3 §5.3, S3-A53, S3-A66): tạo bằng superuser bootstrap, KHÔNG `OWNER`
 * (owner = superuser như production), rồi chạy lại CHÍNH script init của DBA cho database đó (quyền theo database:
 * schema `auth`, grant schema, default privilege, `lc_messages`). Test migration không đụng DB dùng chung.
 */
export async function createScratchDb(prefix: string): Promise<ScratchDb> {
  const name = `${prefix}_${process.pid}_${Date.now().toString(36)}`;
  if (!NAME.test(name))
    throw new Error(`invalid scratch database name ${name}`);
  await execInPg(
    `psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c 'CREATE DATABASE ${name} TEMPLATE template0'`,
  );
  await execInPg(`POSTGRES_DB=${name} bash ${INIT_SCRIPT}`);
  const { pg: p } = getInfra();
  const creds: Record<'owner' | 'app' | 'auth', Creds> = {
    owner: p.owner,
    app: p.app,
    auth: p.auth,
  };
  return {
    name,
    async client(role) {
      const c = new pg.Client({
        host: p.host,
        port: p.port,
        database: name,
        ...creds[role],
      });
      await c.connect();
      return c;
    },
    async drop() {
      await execInPg(
        `psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c 'DROP DATABASE IF EXISTS ${name} WITH (FORCE)'`,
      );
    },
  };
}
