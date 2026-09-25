import { readFileSync } from 'node:fs';
import type { ConnectionOptions } from 'node:tls';
import type { ConfigOf } from '../config/index.js';
import type { databaseConfig } from './database.config.js';

/** Option `ssl` của pg, dùng chung cho connection app/relay và migrator (cùng DB_SSL_MODE). */
export function tlsOptions(
  db: ConfigOf<typeof databaseConfig>,
): false | ConnectionOptions {
  if (db.sslMode === 'disable') return false;
  return {
    rejectUnauthorized: db.sslMode === 'verify-full',
    ...(db.sslCaPath ? { ca: readFileSync(db.sslCaPath, 'utf8') } : {}),
  };
}
