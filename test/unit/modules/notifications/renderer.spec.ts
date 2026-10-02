import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MjmlHandlebarsRenderer,
  TemplateNotFoundError,
} from '../../../../src/modules/notifications/infra/mjml-handlebars.renderer.js';
import {
  TEMPLATE_KEYS,
  TEMPLATE_PARAMS,
} from '../../../../src/modules/notifications/templates.js';

const REPO_TEMPLATES = 'src/modules/notifications/templates';
const make = async (dir = REPO_TEMPLATES, locale = 'en') => {
  const r = new MjmlHandlebarsRenderer(dir, { defaultLocale: locale });
  await r.onModuleInit();
  return r;
};
const tmp: string[] = [];
/** Handlebars escape cả `=` (`&#x3D;`), `'`, `` ` `` trong attribute; so sánh URL SAU khi decode HTML (review I1). */
const decodeHtml = (v: string) =>
  v
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) =>
      String.fromCodePoint(Number.parseInt(h, 16)),
    )
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
const hrefs = (html: string) =>
  [...html.matchAll(/href="([^"]*)"/g)].map((m) => decodeHtml(m[1] ?? ''));
const withTemplateCopy = (file: string, content: string) => {
  const dir = mkdtempSync(join(tmpdir(), 'tpl-'));
  tmp.push(dir);
  cpSync(REPO_TEMPLATES, dir, { recursive: true });
  writeFileSync(join(dir, file), content);
  return dir;
};
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('MjmlHandlebarsRenderer', () => {
  it('renders change-email confirmation as an escaped security notice', async () => {
    const r = await make();
    const displayName = '<script>alert(1)</script>{{x}}';
    const url = 'https://a.test/v?token="quoted"&x=1';
    const out = r.render('change-email-confirmation', 'en', {
      displayName,
      url,
    });
    expect(out.subject).toBe('Confirm your account email change');
    expect(out.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;{{x}}');
    expect(out.html).not.toContain('<script>alert(1)');
    expect(out.html).toContain('&quot;quoted&quot;');
    expect(hrefs(out.html)).toContain(url);
    expect(out.text).toContain(displayName);
    expect(out.text).toContain(url);
    for (const body of [out.html, out.text]) {
      expect(body).toContain('Someone requested changing your account email.');
      expect(body).toContain(
        'If this was not you, ignore this email and secure your account.',
      );
    }
  });
  it.each([true, false])(
    'renders the two-factor state %s in every output',
    async (enabled) => {
      const r = await make();
      const occurredAt = '2026-09-27T10:00:00.000Z';
      const out = r.render('two-factor-changed', 'en', {
        name: 'Ann',
        enabled,
        occurredAt,
      });
      const state = enabled ? 'on' : 'off';
      expect(out.subject).toBe(`Two-factor authentication turned ${state}`);
      for (const body of [out.html, out.text]) {
        expect(body).toContain(`Two-factor authentication was turned ${state}`);
        expect(body).toContain(occurredAt);
      }
    },
  );
  it('escapes quotes in HTML attributes without escaping plain text links', async () => {
    const r = await make();
    const url = 'https://a.test/v?token="quoted"&x=1';
    const out = r.render('verify-email', 'en', { name: 'Ann', url });
    expect(hrefs(out.html)).toContain(url);
    expect(out.html).toContain('&quot;quoted&quot;');
    expect(out.text).toContain(url);
  });
  it('renders every shipped template for the default locale', async () => {
    const r = await make();
    const samples = {
      'verify-email': {
        name: 'Ann',
        url: 'https://app.example.test/v?token=a&x=1',
      },
      'reset-password': {
        name: 'Ann',
        url: 'https://app.example.test/r?token=b',
      },
      'two-factor-changed': {
        name: 'Ann',
        enabled: true,
        occurredAt: '2026-09-27T10:00:00.000Z',
      },
      'existing-account': { name: 'Ann' },
      'change-email-confirmation': {
        displayName: 'Ann',
        url: 'https://app.example.test/change?token=c',
      },
      'org-invitation': {
        orgName: 'Acme',
        inviterName: 'Ann',
        roleName: 'Member',
        acceptUrl: 'https://app.example.test/invitations/accept#token=abc',
        expiresAt: '2026-10-06T00:00:00.000Z',
      },
      'ownership-transfer-requested': {
        name: 'Ann',
        orgName: 'Acme',
        requestedByName: 'Bob',
        expiresAt: '2026-10-06T00:00:00.000Z',
      },
    } as const;
    for (const key of TEMPLATE_KEYS) {
      const out = r.render(key, 'en', samples[key]);
      expect(out.subject.length).toBeGreaterThan(0);
      expect(out.subject).not.toMatch(/[\r\n]/);
      expect(out.html).toContain('<html');
      expect(out.text).toContain('Ann');
    }
    const html = r.render('verify-email', 'en', samples['verify-email']).html;
    expect(hrefs(html)).toContain('https://app.example.test/v?token=a&x=1');
    expect(html).not.toContain('href="https://app.example.test/v?token=a&x=1"'); // vẫn escape trong HTML thô
  });
  it('two-factor-changed: the operator reset branch says what happened and what to do next', async () => {
    const r = await make();
    const out = r.render('two-factor-changed', 'en', {
      name: 'Ann',
      enabled: false,
      operatorReset: true,
      occurredAt: '2026-10-01T00:00:00.000Z',
    });
    expect(out.subject).toBe(
      'Your password and two-factor authentication were reset',
    );
    expect(out.text).toContain(
      'An operator reset the password and two-factor authentication of your account',
    );
    expect(out.html).toContain(
      'An operator reset the password and two-factor authentication of your account',
    );
  });
  it('org-invitation renders without an inviter name (external mode) and keeps the token fragment in the link', async () => {
    const r = await make();
    const acceptUrl =
      'https://app.example.test/invitations/accept#token=Zm9v_YmFy-';
    const out = r.render('org-invitation', 'en', {
      orgName: '<b>Acme</b>',
      inviterName: null,
      roleName: 'Member',
      acceptUrl,
      expiresAt: '2026-10-06T00:00:00.000Z',
    });
    expect(out.subject).toBe("You're invited to join <b>Acme</b>");
    expect(out.html).toContain('&lt;b&gt;Acme&lt;/b&gt;');
    expect(out.text).toContain(
      'You are invited to join <b>Acme</b> as Member.',
    );
    expect(hrefs(out.html)).toContain(acceptUrl);
    expect(out.text).toContain(acceptUrl);
    const named = r.render('org-invitation', 'en', {
      orgName: 'Acme',
      inviterName: 'Ann',
      roleName: 'Admin',
      acceptUrl,
      expiresAt: '2026-10-06T00:00:00.000Z',
    });
    expect(named.text).toContain('Ann invited you to join Acme as Admin.');
  });
  it('escapes user-provided params and rejects CRLF in subject params', async () => {
    const r = await make();
    const out = r.render('verify-email', 'en', {
      name: '<script>alert(1)</script>{{x}}',
      url: 'https://a.test/v',
    });
    expect(out.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;{{x}}');
    expect(out.html).not.toContain('<script>alert(1)');
    expect(
      TEMPLATE_PARAMS['verify-email'].safeParse({
        name: 'x\r\nBcc: evil@x',
        url: 'https://a.test',
      }).success,
    ).toBe(false);
  });
  it('unknown locale at render time is a TemplateNotFoundError (permanent)', async () => {
    const r = await make();
    expect(() =>
      r.render('verify-email', 'fr', { name: 'A', url: 'https://a.test' }),
    ).toThrow(TemplateNotFoundError);
  });
  it('refuses to boot when the default locale is missing for a template', async () => {
    await expect(make(REPO_TEMPLATES, 'vi')).rejects.toThrow(
      /missing templates for locale "vi"/,
    );
  });
  it('refuses to boot on an invalid MJML template (strict validation)', async () => {
    const dir = withTemplateCopy(
      'verify-email/en/body.mjml',
      '<mjml><mj-body><mj-bogus/></mj-body></mjml>',
    );
    await expect(make(dir)).rejects.toThrow(/verify-email\/en\/body\.mjml/);
  });
  it('refuses to boot on a handlebars syntax error (compile is lazy; boot precompiles — review M8)', async () => {
    const dir = withTemplateCopy(
      'two-factor-changed/en/subject.hbs',
      '{{#if enabled}}Turned on',
    );
    await expect(make(dir)).rejects.toThrow(
      /two-factor-changed\/en\/subject\.hbs/,
    );
  });
  it('refuses to boot on an unknown helper (knownHelpersOnly)', async () => {
    const dir = withTemplateCopy(
      'existing-account/en/text.hbs',
      'Hi {{shout name}}',
    );
    await expect(make(dir)).rejects.toThrow(/existing-account\/en\/text\.hbs/);
  });
});
