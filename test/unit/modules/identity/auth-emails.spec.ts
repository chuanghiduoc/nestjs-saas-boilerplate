import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../../../../src/core/errors/index.js';
import { identityGuardConfig } from '../../../../src/modules/identity/identity.config.js';
import { AuthEmails } from '../../../../src/modules/identity/application/auth-emails.js';
import { EmailNotifications } from '../../../../src/modules/notifications/index.js';
import { InvalidEmailRequestError } from '../../../../src/modules/notifications/errors.js';

const ADDRESS = 'victim@example.test';
const URL_WITH_TOKEN = 'https://api.example.test/verify-email?token=secret-t';
const TOKEN = 'secret-t';

class ThrowingEmails extends EmailNotifications {
  constructor(private readonly err: unknown) {
    super();
  }
  request(): Promise<{ created: boolean }> {
    return Promise.reject(this.err);
  }
}

/** Lỗi pg giống thật: message chứa dữ liệu, `code` là SQLSTATE. */
const pgError = () =>
  Object.assign(new Error(`insert failed for ${ADDRESS} ${TOKEN}`), {
    code: '42501',
  });

const make = (err: unknown) =>
  new AuthEmails(new ThrowingEmails(err), identityGuardConfig.schema.parse({}));
const user = { id: 'u1', email: ADDRESS, name: 'U' };

describe('AuthEmails failure logging (review I2)', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    [
      'caller error',
      new InvalidEmailRequestError(
        'invalid params for template verify-email: name',
      ),
      { errorClass: 'InvalidEmailRequestError' },
    ],
    ['pg error', pgError(), { errorClass: 'Error', sqlState: '42501' }],
    [
      'wrapped pg error',
      new Error('tx failed', { cause: pgError() }),
      { errorClass: 'Error', sqlState: '42501' },
    ],
    [
      'AppError',
      new AppError({ code: 'service_unavailable', status: 503, title: 'x' }),
      { errorClass: 'AppError', code: 'service_unavailable' },
    ],
  ])(
    '%s: logs template + class + code without address/url/token, then rethrows',
    async (_n, err, fields) => {
      const log = vi
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      await expect(
        make(err).verification({ user, url: URL_WITH_TOKEN, token: TOKEN }),
      ).rejects.toBe(err);
      expect(log).toHaveBeenCalledTimes(1);
      const [detail, message] = log.mock.calls[0] ?? [];
      expect(detail).toEqual({
        event: 'auth_email_request_failed',
        template: 'verify-email',
        userId: 'u1',
        ...fields,
      });
      const logged = JSON.stringify(log.mock.calls);
      expect(logged).not.toContain(ADDRESS);
      expect(logged).not.toContain(TOKEN);
      expect(typeof message).toBe('string');
    },
  );

  it('logs the template of every callback', async () => {
    const log = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const e = make(pgError());
    await expect(
      e.reset({ user, url: URL_WITH_TOKEN, token: TOKEN }),
    ).rejects.toThrow();
    await expect(e.existingAccount({ user })).rejects.toThrow();
    await expect(e.twoFactorChanged(user, 's1', true)).rejects.toThrow();
    expect(log.mock.calls.map(([d]) => d)).toMatchObject([
      { template: 'reset-password' },
      { template: 'existing-account' },
      { template: 'two-factor-changed' },
    ]);
  });
});
