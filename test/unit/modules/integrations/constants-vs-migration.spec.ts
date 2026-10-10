import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFINER_LIMIT_MAX } from '../../../../src/core/sweep/index.js';
import {
  WEBHOOK_DESCRIPTION_MAX_LENGTH,
  WEBHOOK_PARTITIONS_LOCK_KEY,
  WEBHOOK_RETENTION_MIN_MONTHS,
  WEBHOOK_URL_MAX_LENGTH,
  WEBHOOK_URL_MIN_LENGTH,
} from '../../../../src/modules/integrations/constants.js';
import { LAST_ERRORS } from '../../../../src/modules/integrations/domain/webhook-delivery.js';
import { WEBHOOK_BODY_MAX_BYTES } from '../../../../src/modules/integrations/domain/webhook-payload.js';

/** Migration viết cứng, test so với code (mẫu A-10 của spec SP6). */
const DIR = 'src/migrations/integrations';
const file = readdirSync(DIR).find((f) => f.endsWith('_webhooks.ts'));
const sql = file ? readFileSync(join(DIR, file), 'utf8') : '';

describe('constants hard-coded in the webhooks migration equal the code (spec SP6 §6.7)', () => {
  it('finds the migration', () => {
    expect(file).toBeDefined();
  });
  it('lock key, retention floor, body cap, url and description bounds, p_limit cap', () => {
    expect(sql).toContain(
      `pg_try_advisory_xact_lock(${WEBHOOK_PARTITIONS_LOCK_KEY})`,
    );
    expect(sql).toContain(
      `p_retention_months < ${WEBHOOK_RETENTION_MIN_MONTHS} OR`,
    );
    expect(sql).toContain(`octet_length(body) <= ${WEBHOOK_BODY_MAX_BYTES}`);
    expect(sql).toContain(
      `char_length(url) BETWEEN ${WEBHOOK_URL_MIN_LENGTH} AND ${WEBHOOK_URL_MAX_LENGTH}`,
    );
    expect(sql).toContain(
      `char_length(description) BETWEEN 1 AND ${WEBHOOK_DESCRIPTION_MAX_LENGTH}`,
    );
    expect(sql).toContain(`p_limit > ${DEFINER_LIMIT_MAX}`);
  });
  it('the last_error CHECK lists exactly LAST_ERRORS, in order', () => {
    const m =
      /webhook_deliveries_last_error_ck CHECK \(last_error IN \(([^)]*)\)\)/.exec(
        sql,
      );
    expect(m?.[1]?.split(',').map((s) => s.trim().replaceAll("'", ''))).toEqual(
      [...LAST_ERRORS],
    );
  });
});
