import { execFileSync } from 'node:child_process';
import { expect, inject } from 'vitest';

/** Mức pino: 50 = error, 60 = fatal. */
const PINO_ERROR = 50;

export function compose(args: string[]): string {
  try {
    return execFileSync(
      'docker',
      [...inject('smoke').composeArgs, '--profile', 'app', ...args],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (err) {
    const out =
      typeof err === 'object' &&
      err !== null &&
      'stdout' in err &&
      'stderr' in err
        ? `${String(err.stdout)}${String(err.stderr)}`
        : String(err);
    throw new Error(`docker compose ${args.join(' ')} failed:\n${out}`);
  }
}
export function psql(sql: string): string {
  const { superuser, dbName } = inject('smoke');
  return compose([
    'exec',
    '-T',
    'postgres',
    'psql',
    '-v',
    'ON_ERROR_STOP=1',
    '-At',
    '-U',
    superuser,
    '-d',
    dbName,
    '-c',
    sql,
  ]).trim();
}
export function logsSince(sinceIso: string): string {
  return compose([
    'logs',
    '--no-color',
    '--no-log-prefix',
    '--since',
    sinceIso,
    'api',
    'worker',
  ]);
}
export function workerHealth(): string {
  const id = compose(['ps', '-q', 'worker']).trim();
  return execFileSync(
    'docker',
    ['inspect', '--format', '{{.State.Health.Status}}', id],
    { encoding: 'utf8' },
  ).trim();
}
/**
 * Kết quả `SHOW <what>` của console admin PgBouncer (một dòng một bản ghi, khoá = tên cột). Chạy psql trong
 * container postgres, đăng nhập `app_user` (smoke khai `STATS_USERS`) qua TLS verify-full; mật khẩu lấy từ
 * env của chính container đó nên không đi qua test.
 */
export function pgbouncerShow(what: 'CLIENTS'): Record<string, string>[] {
  const conn =
    'host=pgbouncer port=5432 dbname=pgbouncer user=app_user sslmode=verify-full sslrootcert=/certs/ca.crt';
  const out = compose([
    'exec',
    '-T',
    'postgres',
    'sh',
    '-c',
    `PGPASSWORD="$APP_USER_PASSWORD" psql "${conn}" -A -F '|' -P footer=off -c 'SHOW ${what}'`,
  ]);
  const [header = '', ...rows] = out.split(/\r?\n/).filter(Boolean);
  const cols = header.split('|');
  return rows.map((r) => {
    const cells = r.split('|');
    return Object.fromEntries(cols.map((c, i) => [c, cells[i] ?? '']));
  });
}

/**
 * Dòng không phải JSON được phép trong log của api/worker (mỗi mục: regex + lý do). Hiện rỗng: mọi output
 * của app đi qua pino. Chỉ thêm khi đã rõ nguồn và chắc chắn vô hại (ví dụ cảnh báo của Node lúc boot).
 */
const NON_JSON_ALLOWLIST: readonly { pattern: RegExp; reason: string }[] = [];

const parseJsonObject = (line: string): object | undefined => {
  try {
    const v: unknown = JSON.parse(line);
    return typeof v === 'object' && v !== null ? v : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Không dòng log nào mức error/fatal, không dòng nào ngoài JSON của pino (trừ allowlist), và không dòng
 * nào chứa chuỗi cấm (email, token, mật khẩu của smoke).
 */
export function assertCleanLogs(
  logs: string,
  forbidden: readonly string[],
): void {
  const lines = logs.split(/\r?\n/).filter(Boolean);
  const nonJson = lines.filter(
    (l) =>
      parseJsonObject(l) === undefined &&
      !NON_JSON_ALLOWLIST.some((a) => a.pattern.test(l)),
  );
  expect(nonJson, 'non-JSON log lines').toEqual([]);
  const errors = lines.filter((l) => {
    const parsed = parseJsonObject(l);
    return (
      parsed !== undefined &&
      'level' in parsed &&
      typeof parsed.level === 'number' &&
      parsed.level >= PINO_ERROR
    );
  });
  expect(errors, 'error/fatal log lines').toEqual([]);
  for (const f of forbidden)
    expect(
      lines.filter((l) => l.includes(f)),
      `logs must not contain ${f}`,
    ).toEqual([]);
}

/** Cookie jar tối thiểu (không áp `Secure`: smoke gọi thẳng cổng HTTP của api, đóng vai ingress đã terminate TLS). */
export class CookieJar {
  private readonly jar = new Map<string, string>();
  absorb(res: Response): void {
    for (const c of res.headers.getSetCookie()) {
      const [pair = '', ...attrs] = c.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      const expired = attrs.some(
        (a) =>
          /^\s*max-age=0\s*$/i.test(a) ||
          /^\s*expires=thu, 01 jan 1970/i.test(a),
      );
      if (expired || value === '') this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }
  get(name: string): string | undefined {
    return this.jar.get(name);
  }
  header(): string {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  clear(): void {
    this.jar.clear();
  }
}
