import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { errSerializer } from '../../../src/core/logging/index.js';
import { resilienceConfig } from '../../../src/core/resilience/resilience.config.js';
import type { INestApplication } from '@nestjs/common';
import { v7 } from 'uuid';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ResilienceModule,
  ResiliencePolicies,
} from '../../../src/core/resilience/index.js';
import { MailSendError } from '../../../src/modules/notifications/errors.js';
import { NodemailerTransport } from '../../../src/modules/notifications/infra/nodemailer.transport.js';
import { smtpConfig } from '../../../src/modules/notifications/notifications.config.js';
import { createTestApp } from '../../support/app-factory.js';
import { startFakeSmtp, type FakeSmtp } from '../../support/fake-smtp.js';
import { mailpitFromInfra } from '../../support/mailpit.js';

const DEADLINE_MS = 500;
const BREAKER_THRESHOLD = 2;
const mail = (to: string) => ({
  to,
  subject: 's',
  html: '<p>h</p>',
  text: 't',
  messageId: `<${v7()}@example.test>`,
});

describe('NodemailerTransport', () => {
  let app: INestApplication | undefined;
  let fake: FakeSmtp | undefined;
  afterEach(async () => {
    await app?.close();
    await fake?.close();
    vi.unstubAllEnvs();
    app = undefined;
    fake = undefined;
  });
  const transportFor = async (
    port?: number,
    overrides: Record<string, number> = {},
  ) => {
    if (port !== undefined) {
      vi.stubEnv('SMTP_HOST', '127.0.0.1');
      vi.stubEnv('SMTP_PORT', String(port));
    }
    vi.stubEnv('SMTP_SEND_DEADLINE_MS', String(DEADLINE_MS));
    vi.stubEnv(
      'RESILIENCE_OVERRIDES',
      JSON.stringify({
        smtp: { breakerThreshold: BREAKER_THRESHOLD, ...overrides },
      }),
    );
    if (port === undefined) app = await createTestApp([ResilienceModule]);
    else {
      vi.stubEnv('SMTP_SECURE', 'false');
      vi.stubEnv('SMTP_REQUIRE_TLS', 'false');
      vi.stubEnv('MAIL_FROM', 'Sender <sender@example.test>');
      const module = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({
            isGlobal: true,
            ignoreEnvFile: true,
            load: [smtpConfig, resilienceConfig],
          }),
          ResilienceModule,
        ],
      }).compile();
      app = module.createNestApplication();
      await app.init();
    }
    return new NodemailerTransport(
      app.get(smtpConfig.KEY),
      app.get(ResiliencePolicies),
    );
  };

  it('delivers to Mailpit with the fixed Message-ID', async () => {
    const t = await transportFor();
    const to = `t-${v7()}@example.test`;
    const m = mail(to);
    await t.send(m, new AbortController().signal);
    const got = await mailpitFromInfra().waitFor(to);
    expect(got.Subject).toBe('s');
  });
  it('550 with the address in the reply → SMTP_PERMANENT without the address', async () => {
    fake = await startFakeSmtp('reject550');
    const t = await transportFor(fake.port);
    const err = await t
      .send(mail('victim@example.com'), new AbortController().signal)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MailSendError);
    expect(err).toMatchObject({ code: 'SMTP_PERMANENT', responseCode: 550 });
    expect(JSON.stringify(err)).not.toContain('victim@example.com');
    expect(JSON.stringify(errSerializer(err))).not.toContain(
      'victim@example.com',
    );
    if (err instanceof Error) expect(err.cause).toBeUndefined();
    expect(err).toHaveProperty('message', 'SMTP send failed (SMTP_PERMANENT)');
  });
  it('accepts a message using a real SMTP connection', async () => {
    fake = await startFakeSmtp('accept');
    const t = await transportFor(fake.port);
    await expect(
      t.send(mail('x@example.com'), new AbortController().signal),
    ).resolves.toBeUndefined();
    await vi.waitFor(() => expect(fake!.closedConnections()).toBe(1));
  });
  it('does not connect when already aborted', async () => {
    fake = await startFakeSmtp('accept');
    const t = await transportFor(fake.port);
    await expect(
      t.send(
        mail('x@example.com'),
        AbortSignal.abort(new Error('victim@example.com')),
      ),
    ).rejects.toMatchObject({ code: 'SMTP_TIMEOUT' });
    expect(fake.closedConnections()).toBe(0);
  });
  it('cancellation closes an active SMTP connection without leaking the abort reason', async () => {
    fake = await startFakeSmtp('hang');
    const t = await transportFor(fake.port);
    const controller = new AbortController();
    const sending = t.send(mail('victim@example.com'), controller.signal);
    const result = expect(sending).rejects.toMatchObject({
      code: 'SMTP_TIMEOUT',
      message: 'SMTP send failed (SMTP_TIMEOUT)',
    });
    const timer = setTimeout(
      () => controller.abort(new Error('victim@example.com')),
      DEADLINE_MS / 2,
    );
    try {
      await result;
      await vi.waitFor(() => expect(fake!.closedConnections()).toBe(1));
    } finally {
      clearTimeout(timer);
    }
  });
  it('the deadline includes the bulkhead queue and a cancelled entry never sends later', async () => {
    fake = await startFakeSmtp('accept');
    const t = await transportFor(fake.port, {
      bulkheadLimit: 1,
      bulkheadQueue: 1,
    });
    let release = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const occupying = app!
      .get(ResiliencePolicies)
      .for('smtp')
      .single.execute(() => blocked);
    try {
      await expect(
        t.send(mail('x@example.com'), new AbortController().signal),
      ).rejects.toMatchObject({ code: 'SMTP_TIMEOUT' });
    } finally {
      release();
      await occupying;
    }
    expect(fake.closedConnections()).toBe(0);
    await expect(
      t.send(mail('x@example.com'), new AbortController().signal),
    ).resolves.toBeUndefined();
    await vi.waitFor(() => expect(fake!.closedConnections()).toBe(1));
  });
  it('451 → SMTP_TRANSIENT', async () => {
    fake = await startFakeSmtp('reject451');
    const t = await transportFor(fake.port);
    await expect(
      t.send(mail('x@example.com'), new AbortController().signal),
    ).rejects.toMatchObject({ code: 'SMTP_TRANSIENT' });
  });
  it('consecutive 550s never open the breaker (permanent errors are results, not failures)', async () => {
    fake = await startFakeSmtp('reject550');
    const t = await transportFor(fake.port);
    for (let i = 0; i < BREAKER_THRESHOLD * 2; i++)
      await expect(
        t.send(mail(`bad-${i}@example.com`), new AbortController().signal),
      ).rejects.toMatchObject({ code: 'SMTP_PERMANENT', responseCode: 550 });
  });
  it('consecutive transient failures DO open the breaker: the next send fails fast without talking SMTP', async () => {
    fake = await startFakeSmtp('reject451');
    const t = await transportFor(fake.port);
    for (let i = 0; i < BREAKER_THRESHOLD; i++)
      await expect(
        t.send(mail('x@example.com'), new AbortController().signal),
      ).rejects.toMatchObject({ code: 'SMTP_TRANSIENT', responseCode: 451 });
    const open = await t
      .send(mail('x@example.com'), new AbortController().signal)
      .catch((e: unknown) => e);
    expect(open).toMatchObject({ code: 'SMTP_TRANSIENT' });
    expect(open).not.toHaveProperty('responseCode', 451);
    await vi.waitFor(() =>
      expect(fake!.closedConnections()).toBe(BREAKER_THRESHOLD),
    );
  });
  it('a hanging server hits the total deadline, and the pooled connection is closed', async () => {
    fake = await startFakeSmtp('hang');
    const t = await transportFor(fake.port);
    const started = Date.now();
    await expect(
      t.send(mail('x@example.com'), new AbortController().signal),
    ).rejects.toMatchObject({ code: 'SMTP_TIMEOUT' });
    expect(Date.now() - started).toBeLessThan(DEADLINE_MS * 4);
    await vi.waitFor(() =>
      expect(fake!.closedConnections()).toBeGreaterThan(0),
    );
  });
});
