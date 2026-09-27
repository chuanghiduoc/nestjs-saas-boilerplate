import { createTransport } from 'nodemailer';
import { describe, expect, it } from 'vitest';
import { getInfra } from '../../support/infra.js';
import { mailpitFromInfra } from '../../support/mailpit.js';

describe('mailpit test harness', () => {
  it('receives SMTP mail and exposes it through the API', async () => {
    const { mailpit } = getInfra();
    const to = `harness-${Date.now()}@example.test`;
    const t = createTransport({
      host: mailpit.smtpHost,
      port: mailpit.smtpPort,
      secure: false,
    });
    await t.sendMail({
      from: 'noreply@example.test',
      to,
      subject: 'harness',
      text: 'hello',
      html: '<p>hello</p>',
    });
    t.close();
    const msg = await mailpitFromInfra().waitFor(to, { subject: /harness/ });
    expect(msg.Text.trim()).toBe('hello');
  });
});
