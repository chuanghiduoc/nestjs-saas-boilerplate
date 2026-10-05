import { describe, expect, it } from 'vitest';
import {
  parseStaffResetArgs,
  terminalProblem,
} from '../../../../src/modules/identity/infra/better-auth/staff-2fa-reset.js';

const ID = '0190e1c8-0000-7000-8000-0000000000a1';
const ok = (argv: string[]) => {
  const r = parseStaffResetArgs(argv);
  if (!r.ok) throw new Error(r.message);
  return r.args;
};

/** Spec SP3 §5.2 hàng CLI (r6 N6-3, N6-4): lỗi cách dùng không phụ thuộc env, không chạm DB. */
describe('identity:staff-2fa-reset arguments and terminal', () => {
  it('parses the required --user-id and --ticket, the optional --for-promotion and --password-file', () => {
    expect(ok(['--user-id', ID, '--ticket', 'SUP-42'])).toEqual({
      userId: ID,
      ticket: 'SUP-42',
      forPromotion: false,
      passwordFile: undefined,
    });
    expect(
      ok([
        '--user-id',
        ID,
        '--ticket',
        'SUP-42',
        '--for-promotion',
        '--password-file',
        '/tmp/p',
      ]),
    ).toEqual({
      userId: ID,
      ticket: 'SUP-42',
      forPromotion: true,
      passwordFile: '/tmp/p',
    });
  });
  it.each([
    [['--ticket', 'T'], /--user-id is required/],
    [['--user-id', ID], /--ticket is required/],
    [
      ['--user-id', ID, '--ticket', ''],
      /--ticket must be 1-128 printable characters/,
    ],
    [
      ['--user-id', ID, '--ticket', 'x'.repeat(129)],
      /--ticket must be 1-128 printable characters/,
    ],
    [
      ['--user-id', ID, '--ticket', 'a\nb'],
      /--ticket must be 1-128 printable characters/,
    ],
    [['--user-id', ID, '--ticket', 'T', '--yes'], /Unknown option '--yes'/],
  ])('%j → refused before any DB access', (argv, message) => {
    const r = parseStaffResetArgs(argv);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(message);
  });
  it.each([
    ID.toUpperCase(),
    ` ${ID}`,
    `{${ID}}`,
    ID.replaceAll('-', ''),
    'not-a-uuid',
  ])(
    'Review Focus 5: --user-id %j must be a canonical lowercase UUID',
    (userId) => {
      const r = parseStaffResetArgs(['--user-id', userId, '--ticket', 'T']);
      expect(r).toEqual({
        ok: false,
        message: '--user-id must be a canonical lowercase UUID',
      });
    },
  );
  it('the confirmation is always interactive: no TTY on stdin → refused; stdout not a TTY needs --password-file', () => {
    const args = ok(['--user-id', ID, '--ticket', 'T']);
    expect(
      terminalProblem(args, { stdinIsTTY: false, stdoutIsTTY: true }),
    ).toMatch(/interactive terminal/);
    expect(
      terminalProblem(args, { stdinIsTTY: true, stdoutIsTTY: false }),
    ).toMatch(/--password-file/);
    expect(
      terminalProblem(
        { ...args, passwordFile: '/tmp/p' },
        { stdinIsTTY: true, stdoutIsTTY: false },
      ),
    ).toBeUndefined();
    expect(
      terminalProblem(args, { stdinIsTTY: true, stdoutIsTTY: true }),
    ).toBeUndefined();
  });
});
