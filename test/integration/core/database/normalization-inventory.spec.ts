import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getInfra } from '../../../support/infra.js';

/**
 * Cột của mọi bảng SP2 đã được phân tích ở bảng chuẩn hoá của spec §5.16. Có cột mới mà chưa phân tích
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
