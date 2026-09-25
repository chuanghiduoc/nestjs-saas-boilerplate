import { randomBytes } from 'node:crypto';

/** Vitest cô lập module theo từng file test, nên prefix này khác nhau giữa các file và giống nhau trong một file. */
const FILE_REDIS_PREFIX = `t${randomBytes(4).toString('hex')}`;

/** Mỗi task thêm config bắt buộc (không có default) thì thêm key vào đây. */
export function baseTestEnv(): Record<string, string> {
  return {
    APP_ROLE: 'api',
    NODE_ENV: 'test',
    REDIS_KEY_PREFIX: FILE_REDIS_PREFIX,
  };
}

export const randomSecret = (bytes = 32): string =>
  randomBytes(bytes).toString('base64url');
