import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Spec SP3 §5.2 (7) (r7, r8 R8-S4): luật mật khẩu của nhân viên dựa vào ba chỗ của `api/routes/password.mjs` bản đã cài
 * (mẫu `better-auth-hardening.spec.ts`). Nâng Better Auth mà đổi một chỗ thì test đỏ trước khi luật âm thầm lệch handler.
 */
describe('better-auth /reset-password still reads the token the way the hook assumes (drift)', () => {
  const src = readFileSync(
    join(
      process.cwd(),
      'node_modules',
      'better-auth',
      'dist',
      'api',
      'routes',
      'password.mjs',
    ),
    'utf8',
  );
  const route = src.slice(
    src.indexOf('const resetPassword = createAuthEndpoint("/reset-password"'),
  );
  it('query and body token are plain z.string() (no coercion)', () => {
    expect(route).toContain(
      'query: z.object({ token: z.string().optional() }).optional()',
    );
    expect(route).toMatch(
      /token: z\.string\(\)\.meta\(\{ description: "The token to reset the password" \}\)\.optional\(\)/,
    );
  });
  it('the handler picks body before query with ||', () => {
    expect(route).toContain(
      'const token = ctx.body.token || ctx.query?.token;',
    );
  });
  it('the verification identifier is reset-password:<token>', () => {
    expect(route).toContain('const id = `reset-password:${token}`;');
  });
});
