import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DISPLAY_NAME_MAX,
  TEMPLATE_KEYS,
  TEMPLATE_PARAMS,
} from '../../../../src/modules/notifications/templates.js';

describe('notification template catalog', () => {
  it('matches the template folders, the params map and exactly the keys inserted into email_templates by the migrations', () => {
    expect(new Set(readdirSync('src/modules/notifications/templates'))).toEqual(
      new Set(TEMPLATE_KEYS),
    );
    expect(Object.keys(TEMPLATE_PARAMS)).toEqual([...TEMPLATE_KEYS]);
    // Nguồn sự thật của key ở DB là các dòng `INSERT INTO email_templates (key) VALUES …` (spec SP3 §6.13): 3A chèn năm
    // key của SP2, 3C và 3D mỗi plan chèn dòng của mình. Chỉ đọc phần `up` của từng migration notifications.
    const dir = 'src/migrations/notifications';
    const inserted = readdirSync(dir)
      .filter((f) => f.endsWith('.ts'))
      .flatMap((f) => {
        const up =
          /override up\(\)[\s\S]*?override down\(\)/.exec(
            readFileSync(`${dir}/${f}`, 'utf8'),
          )?.[0] ?? '';
        const values =
          /INSERT INTO email_templates \(key\) VALUES ([^;]+);/.exec(up)?.[1] ??
          '';
        return [...values.matchAll(/'([a-z][a-z0-9-]*)'/g)].map((m) => m[1]);
      });
    expect(inserted.sort()).toEqual([...TEMPLATE_KEYS].sort());
  });
  it('org-invitation: inviterName is nullable but always present, URLs are validated, no address field', () => {
    const schema = TEMPLATE_PARAMS['org-invitation'];
    const params = {
      orgName: 'Acme',
      inviterName: null,
      roleName: 'Member',
      acceptUrl: 'https://app.example.test/invitations#token=x',
      expiresAt: '2026-10-06T00:00:00.000Z',
    };
    expect(schema.safeParse(params).success).toBe(true);
    expect(schema.safeParse({ ...params, inviterName: 'Ann' }).success).toBe(
      true,
    );
    for (const invalid of [
      { ...params, inviterName: undefined },
      { ...params, orgName: 'Acme\r\nBcc: x@example.test' },
      { ...params, acceptUrl: 'not a url' },
      { ...params, email: 'x@example.test' },
    ])
      expect(schema.safeParse(invalid).success).toBe(false);
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
