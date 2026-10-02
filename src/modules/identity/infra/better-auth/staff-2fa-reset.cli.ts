import { stderr, stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import {
  STAFF_RESET_EXIT_NOT_COMMITTED,
  parseStaffResetArgs,
  runStaffTwoFactorReset,
  terminalProblem,
  type StaffResetTerminal,
} from './staff-2fa-reset.js';

/**
 * Entry mỏng của `pnpm identity:staff-2fa-reset` (spec SP3 §5.2 hàng CLI): kiểm tham số và terminal TRƯỚC khi nạp
 * `auth.cli-config.js` (import động: lỗi cách dùng không phụ thuộc env, không chạm DB), rồi đóng pool trên mọi đường thoát.
 * Log có cấu trúc là một dòng JSON trên stderr (process ngắn, không dựng Nest).
 */
const terminal: StaffResetTerminal = {
  stdinIsTTY: stdin.isTTY === true,
  stdoutIsTTY: stdout.isTTY === true,
  async confirm(prompt) {
    const rl = createInterface({ input: stdin, output: stderr });
    try {
      return await rl.question(prompt);
    } finally {
      rl.close();
    }
  },
  writeSecret: (secret) =>
    new Promise<void>((resolve, reject) =>
      stdout.write(`${secret}\n`, (err) => (err ? reject(err) : resolve())),
    ),
  info: (line) => {
    stderr.write(`${line}\n`);
  },
};

const parsed = parseStaffResetArgs(process.argv.slice(2));
if (!parsed.ok) {
  terminal.info(`identity:staff-2fa-reset: ${parsed.message}`);
  process.exitCode = STAFF_RESET_EXIT_NOT_COMMITTED;
} else {
  const problem = terminalProblem(parsed.args, terminal);
  if (problem) {
    terminal.info(`identity:staff-2fa-reset: ${problem}`);
    process.exitCode = STAFF_RESET_EXIT_NOT_COMMITTED;
  } else {
    const { auth, pool } = await import('./auth.cli-config.js');
    try {
      process.exitCode = await runStaffTwoFactorReset(parsed.args, terminal, {
        auth,
        pool,
        log: (level, entry, message) => {
          stderr.write(
            `${JSON.stringify({ level, time: new Date().toISOString(), ...entry, msg: message })}\n`,
          );
        },
      });
    } finally {
      await pool.end();
    }
  }
}
