import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getInfra } from '../../../support/infra.js';

/**
 * Cột của mọi bảng SP2 và SP3 đã được phân tích (spec SP2 §5.16, spec SP3 §6.12). Có cột mới mà chưa phân tích
 * thì test fail: cập nhật §5.16 (và chú thích migration) trước, rồi mới thêm cột vào đây.
 */
const ANALYSED_COLUMNS: Record<string, readonly string[]> = {
  'public.email_deliveries': [
    'id',
    'public_id',
    'template',
    'locale',
    'recipient_enc',
    'params_enc',
    'state',
    'lease_owner',
    'lease_until',
    'idempotency_key',
    'attempts',
    'enqueue_generation',
    'last_enqueued_at',
    'last_error_code',
    'completed_at',
    'created_at',
    'updated_at',
  ],
  'public.email_templates': ['key', 'created_at', 'updated_at'],
  'auth.user': [
    'id',
    'name',
    'email',
    'email_verified',
    'image',
    'created_at',
    'updated_at',
    'two_factor_enabled',
    'role',
    'banned',
    'ban_reason',
    'ban_expires',
    'registered_event_emitted_at',
  ],
  'auth.session': [
    'id',
    'expires_at',
    'token',
    'created_at',
    'updated_at',
    'ip_address',
    'user_agent',
    'user_id',
    'impersonated_by',
  ],
  'auth.account': [
    'id',
    'account_id',
    'provider_id',
    'user_id',
    'access_token',
    'refresh_token',
    'id_token',
    'access_token_expires_at',
    'refresh_token_expires_at',
    'scope',
    'password',
    'created_at',
    'updated_at',
  ],
  'auth.verification': [
    'id',
    'identifier',
    'value',
    'expires_at',
    'created_at',
    'updated_at',
  ],
  'auth.two_factor': [
    'id',
    'secret',
    'backup_codes',
    'user_id',
    'verified',
    'failed_verification_count',
    'locked_until',
  ],
  'auth.apikey': [
    'id',
    'name',
    'start',
    'prefix',
    'key',
    'reference_id',
    'config_id',
    'refill_interval',
    'refill_amount',
    'last_refill_at',
    'enabled',
    'rate_limit_enabled',
    'rate_limit_time_window',
    'rate_limit_max',
    'request_count',
    'remaining',
    'last_request',
    'expires_at',
    'created_at',
    'updated_at',
    'permissions',
    'metadata',
  ],
  'auth.jwks': [
    'id',
    'public_key',
    'private_key',
    'created_at',
    'expires_at',
    'alg',
    'crv',
  ],
  'auth.rate_limit': ['id', 'key', 'count', 'last_request'],
  'auth.login_attempts': ['key', 'points', 'expire'],
  'auth.user_reclaim': ['user_id', 'reclaimed_at', 'created_at'],
  'auth.security_notice': [
    'id',
    'user_id',
    'kind',
    'created_at',
    'notified_at',
    'abandoned_at',
  ],
  'public.scheduled_tasks': [
    'id',
    'org_id',
    'key',
    'job_name',
    'cron',
    'timezone',
    'payload',
    'enabled',
    'created_at',
    'updated_at',
    'suspended_at',
  ],
};

describe('normalization inventory (spec §5.16)', () => {
  let owner: pg.Client;
  beforeAll(async () => {
    const { pg: p } = getInfra();
    owner = new pg.Client({
      host: p.host,
      port: p.port,
      database: p.database,
      ...p.owner,
    });
    await owner.connect();
  });
  afterAll(async () => owner?.end());

  it.each(Object.entries(ANALYSED_COLUMNS))(
    '%s has exactly the analysed columns',
    async (qualified, expected) => {
      const [schema, table] = qualified.split('.');
      const { rows } = await owner.query<{ column_name: string }>(
        'SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2',
        [schema, table],
      );
      expect(rows.map((r) => r.column_name).sort()).toEqual(
        [...expected].sort(),
      );
    },
  );
});
