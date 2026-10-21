import { z } from 'zod';
import {
  defineConfig,
  defineProductionRule,
  secretMeta,
} from '../config/index.js';

export const redisConfig = defineConfig(
  'redis',
  {
    url: 'REDIS_URL',
    keyPrefix: 'REDIS_KEY_PREFIX',
    commandTimeoutMs: 'REDIS_COMMAND_TIMEOUT_MS',
  },
  z.object({
    url: z
      .url()
      .describe(
        'Redis URL (redis:// or rediss://, include ACL user and password)',
      )
      .meta(secretMeta(['api', 'worker'])),
    keyPrefix: z
      .string()
      .regex(/^[a-z0-9-]+$/)
      .default('app')
      .describe(
        'Service prefix for every Redis key; the environment name is appended',
      ),
    commandTimeoutMs: z.coerce
      .number()
      .int()
      .positive()
      .default(1000)
      .describe('ioredis commandTimeout for non-blocking clients'),
  }),
);

defineProductionRule('redis-tls-acl', (c) => {
  const url =
    typeof c.redis?.url === 'string' ? new URL(c.redis.url) : undefined;
  if (!url) return undefined;
  if (url.protocol !== 'rediss:')
    return 'REDIS_URL must use rediss:// in production';
  if (!url.username || !url.password)
    return 'REDIS_URL must include an ACL username and password in production';
  return undefined;
});
