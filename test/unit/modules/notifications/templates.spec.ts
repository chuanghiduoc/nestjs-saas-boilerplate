import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DISPLAY_NAME_MAX,
  TEMPLATE_KEYS,
  TEMPLATE_PARAMS,
} from '../../../../src/modules/notifications/templates.js';

describe('notification template catalog', () => {
  it('includes change-email-confirmation and matches the folders and migration CHECK exactly', () => {
    expect(TEMPLATE_KEYS).toContain('change-email-confirmation');
    expect(new Set(readdirSync('src/modules/notifications/templates'))).toEqual(
      new Set(TEMPLATE_KEYS),
    );
    expect(Object.keys(TEMPLATE_PARAMS)).toEqual([...TEMPLATE_KEYS]);
    const migration = readFileSync(
      'src/migrations/notifications/Migration20260927145436_email_deliveries.ts',
      'utf8',
    );
    const keys = /CHECK \(template IN \(([^)]+)\)\)/.exec(migration)?.[1];
    expect(keys).toBe(TEMPLATE_KEYS.map((key) => `'${key}'`).join(', '));
  });

  it('accepts only a URL and a single-line bounded displayName, without addresses', () => {
    const schema = TEMPLATE_PARAMS['change-email-confirmation'];
    const params = {
      displayName: 'Ann',
      url: 'https://app.example.test/confirm',
    };
    expect(schema.safeParse(params).success).toBe(true);
    expect(
      schema.safeParse({ ...params, displayName: 'a'.repeat(DISPLAY_NAME_MAX) })
        .success,
    ).toBe(true);
    for (const invalid of [
      { ...params, displayName: 'a'.repeat(DISPLAY_NAME_MAX + 1) },
      { ...params, displayName: 'Ann\r\nBcc: other@example.test' },
      { ...params, url: 'invalid' },
      { url: params.url },
      { displayName: params.displayName },
      { ...params, newEmail: 'new@example.test' },
      { ...params, email: 'old@example.test' },
    ])
      expect(schema.safeParse(invalid).success).toBe(false);
  });
});
