import { randomBytes } from 'node:crypto';
import { dbEnv } from './db.js';
import { getInfra } from './infra.js';

/** Khoá mã hoá field chỉ dùng cho test, sinh ngẫu nhiên theo file test. */
const TEST_FIELD_KEY_ID = 't1';
const TEST_FIELD_KEY = randomBytes(32).toString('base64');

/** Vitest cô lập module theo từng file test, nên prefix này khác nhau giữa các file và giống nhau trong một file. */
const FILE_REDIS_PREFIX = `t${randomBytes(4).toString('hex')}`;

/** Mỗi task thêm config bắt buộc (không có default) thì thêm key vào đây. */
export function baseTestEnv(): Record<string, string> {
  return {
    APP_ROLE: 'api',
    NODE_ENV: 'test',
    REDIS_KEY_PREFIX: FILE_REDIS_PREFIX,
    REDIS_URL: getInfra().redis.url,
    FIELD_ENCRYPTION_KEYS: JSON.stringify({
      [TEST_FIELD_KEY_ID]: TEST_FIELD_KEY,
    }),
    FIELD_ENCRYPTION_ACTIVE_KID: TEST_FIELD_KEY_ID,
    // Cổng tự chọn: nhiều worker/test chạy song song không tranh cổng 3001; chỉ lắng nghe loopback.
    WORKER_HEALTH_PORT: '0',
    WORKER_HEALTH_HOST: '127.0.0.1',
    // Test không có load balancer; test nào cần kiểm tra drain delay thì tự đặt.
    HEALTH_DRAIN_DELAY_MS: '0',
    ...dbEnv(),
  };
}

export const randomSecret = (bytes = 32): string =>
  randomBytes(bytes).toString('base64url');
