import { z } from 'zod';
import { defineConfig } from './define-config.js';

/**
 * Namespace chỉ dành cho hạ tầng compose (postgres/pgbouncer/redis/collector). `pnpm env:example`
 * ghi namespace này ra `.env.infra.example` riêng: file `.env.infra` chỉ dùng để nội suy compose,
 * không bao giờ vào `env_file` của container app (secret hạ tầng không tới app).
 */
export const DEV_INFRA_NAMESPACE = 'devInfra';

export const devInfraConfig = defineConfig(
  DEV_INFRA_NAMESPACE,
  {
    superuser: 'POSTGRES_SUPERUSER',
    superuserPassword: 'POSTGRES_SUPERUSER_PASSWORD',
    appStatementTimeoutMs: 'DB_APP_STATEMENT_TIMEOUT_MS',
    relayStatementTimeoutMs: 'DB_RELAY_STATEMENT_TIMEOUT_MS',
    idleInTxTimeoutMs: 'DB_IDLE_IN_TX_TIMEOUT_MS',
    redisPassword: 'REDIS_PASSWORD',
    dbPortHost: 'DB_PORT_HOST',
    redisPortHost: 'REDIS_PORT_HOST',
    pgbouncerPortHost: 'PGBOUNCER_PORT_HOST',
    httpPortHost: 'HTTP_PORT_HOST',
    composeRedisUrl: 'COMPOSE_REDIS_URL',
    otelPortHost: 'OTEL_PORT_HOST',
  },
  z.object({
    superuser: z
      .string()
      .default('postgres')
      .describe('Postgres superuser (local compose only)'),
    superuserPassword: z
      .string()
      .describe('Postgres superuser password (local compose only)'),
    appStatementTimeoutMs: z.coerce
      .number()
      .int()
      .positive()
      .default(5000)
      .describe('statement_timeout set on role app_user'),
    relayStatementTimeoutMs: z.coerce
      .number()
      .int()
      .positive()
      .default(60000)
      .describe('statement_timeout set on role app_relay'),
    idleInTxTimeoutMs: z.coerce
      .number()
      .int()
      .positive()
      .default(10000)
      .describe('idle_in_transaction_session_timeout for app roles'),
    redisPassword: z.string().describe('Redis password (compose)'),
    dbPortHost: z.coerce
      .number()
      .int()
      .default(5432)
      .describe('Host port for Postgres (bound to 127.0.0.1)'),
    redisPortHost: z.coerce
      .number()
      .int()
      .default(6379)
      .describe('Host port for Redis (bound to 127.0.0.1)'),
    pgbouncerPortHost: z.coerce
      .number()
      .int()
      .default(6432)
      .describe('Host port for PgBouncer (bound to 127.0.0.1)'),
    httpPortHost: z.coerce
      .number()
      .int()
      .default(3000)
      .describe('Host port for the api container (bound to 127.0.0.1)'),
    composeRedisUrl: z
      .url()
      .describe(
        'REDIS_URL used by app containers inside compose, e.g. redis://:<password>@redis:6379; the password must equal REDIS_PASSWORD',
      ),
    otelPortHost: z.coerce
      .number()
      .int()
      .default(4318)
      .describe(
        'Host port for the OTel collector OTLP HTTP receiver (bound to 127.0.0.1)',
      ),
  }),
);
