import { describe, expect, it } from 'vitest';
import { errSerializer } from '../../../../src/core/logging/index.js';
import { toMailSendError } from '../../../../src/modules/notifications/infra/smtp-error.js';
import { MailSendError } from '../../../../src/modules/notifications/errors.js';

const smtpErr = (props: Record<string, unknown>) =>
  Object.assign(
    new Error(
      "Can't send mail - all recipients were rejected: 550 <victim@example.com>",
    ),
    props,
  );

describe('toMailSendError', () => {
  it('rebuilds existing errors instead of retaining attached PII', () => {
    const original = Object.assign(new MailSendError('SMTP_TIMEOUT'), {
      message: 'victim@example.com',
      cause: new Error('victim@example.com'),
      recipient: 'victim@example.com',
      command: 'VICTIM@example.com',
    });
    const result = toMailSendError(original);
    expect(result.code).toBe('SMTP_TIMEOUT');
    expect(result.cause).toBeUndefined();
    expect(result.command).toBeUndefined();
    expect(JSON.stringify(errSerializer(result))).not.toContain('victim');
    expect(JSON.stringify(result)).not.toContain('VICTIM');
  });
  it.each([
    [
      {
        responseCode: 550,
        command: 'RCPT TO',
        response: '550 5.1.1 <victim@example.com> rejected',
        rejected: ['victim@example.com'],
      },
      'SMTP_PERMANENT',
    ],
    [
      {
        responseCode: 451,
        command: 'DATA',
        response: '451 try later <victim@example.com>',
      },
      'SMTP_TRANSIENT',
    ],
    [{ code: 'ETIMEDOUT' }, 'SMTP_TIMEOUT'],
    [{ code: 'ECONNECTION' }, 'SMTP_CONNECTION'],
    [{ code: 'ESOCKET' }, 'SMTP_CONNECTION'],
    [{}, 'SMTP_TRANSIENT'],
  ])('%j → %s, with no address anywhere', (props, code) => {
    const e = toMailSendError(smtpErr(props));
    expect(e.code).toBe(code);
    expect(e.cause).toBeUndefined();
    const serialized = JSON.stringify(errSerializer(e));
    expect(serialized).not.toContain('victim@example.com');
    expect(e.message).not.toContain('victim');
  });
  it('keeps only the SMTP verb of the command', () => {
    expect(
      toMailSendError(
        smtpErr({ responseCode: 550, command: 'RCPT TO:<victim@example.com>' }),
      ).command,
    ).toBe('RCPT TO');
  });
});
