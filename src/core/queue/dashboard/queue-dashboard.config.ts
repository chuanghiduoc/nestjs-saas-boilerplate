import { isIP } from 'node:net';
import { z } from 'zod';
import { defineConfig, defineProductionRule } from '../../config/index.js';

const MAX_PREFIX = { 4: 32, 6: 128 } as const;
const validEntry = (s: string): boolean => {
  const [ip = '', prefix] = s.split('/');
  const family = isIP(ip);
  if (family !== 4 && family !== 6) return false;
  if (prefix === undefined) return true;
  const n = Number(prefix);
  return Number.isInteger(n) && n >= 0 && n <= MAX_PREFIX[family];
};

export const queueDashboardConfig = defineConfig(
  'queueDashboard',
  {
    enabled: 'QUEUE_DASHBOARD_ENABLED',
    host: 'QUEUE_DASHBOARD_HOST',
    port: 'QUEUE_DASHBOARD_PORT',
    basePath: 'QUEUE_DASHBOARD_BASE_PATH',
    ipAllowlist: 'QUEUE_DASHBOARD_IP_ALLOWLIST',
  },
  z.object({
    enabled: z
      .stringbool()
      .default(false)
      .describe(
        'Serve the read-only Bull Board on the worker (enable on exactly one deployment)',
      ),
    host: z
      .string()
      .default('127.0.0.1')
      .describe('Listen host of the dashboard (internal network only)'),
    port: z.coerce
      .number()
      .int()
      .min(0)
      .default(3002)
      .describe(
        'Listen port of the dashboard. compose.yaml maps the worker on 3002; change both together',
      ),
    basePath: z
      .string()
      .startsWith('/')
      .default('/queues')
      .describe('Mount path of the dashboard'),
    ipAllowlist: z
      .string()
      .default('')
      .transform((s) =>
        s
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean),
      )
      .pipe(z.array(z.string().refine(validEntry, 'must be an IP or CIDR')))
      .describe(
        'Client IPs/CIDRs allowed to reach the dashboard (required in production when enabled)',
      ),
  }),
);

defineProductionRule('queue-dashboard-allowlist', (c) =>
  c.queueDashboard?.enabled === true &&
  !(
    Array.isArray(c.queueDashboard.ipAllowlist) &&
    c.queueDashboard.ipAllowlist.length > 0
  )
    ? 'QUEUE_DASHBOARD_IP_ALLOWLIST must not be empty when QUEUE_DASHBOARD_ENABLED=true in production'
    : undefined,
);
