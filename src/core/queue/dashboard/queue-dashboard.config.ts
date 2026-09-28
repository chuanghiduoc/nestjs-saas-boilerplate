import { isIP } from 'node:net';
import { z } from 'zod';
import { defineConfig, defineProductionRule } from '../../config/index.js';

const MAX_PREFIX = { 4: 32, 6: 128 } as const;
/** Prefix chỉ nhận chữ số (không dấu, không khoảng trắng, không rỗng); Number() trên chuỗi này không thể lọt "". */
const PREFIX_PATTERN = /^\d{1,3}$/;
/** Dấu phân tách zone id IPv6 (RFC 6874, `fe80::1%eth0`). */
const IPV6_ZONE_SEPARATOR = '%';

/**
 * Một entry hợp lệ: IP đơn (ngầm định prefix đầy đủ) hoặc đúng một `ip/prefix` với prefix nguyên
 * trong dải của họ IP. `/0` luôn bị cấm ở mọi môi trường (S2-R31): dashboard mở cho mọi địa chỉ vô
 * hiệu hoá allowlist. Trước khi có patch này, `'10.0.0.0/'.split('/')` cho `prefix=''`, `Number('')`
 * là `0`, nên entry gõ sai đó lọt qua thành `/0` và cho phép mọi IP (bao gồm 8.8.8.8).
 */
function isValidAllowlistEntry(entry: string): boolean {
  const parts = entry.split('/');
  if (parts.length > 2) return false; // "/" thừa (a/b/c)
  const [ip = '', prefixRaw] = parts;
  // `isIP('fe80::1%eth0')` trả 6, nhưng BlockList (bộ so khớp allowlist) bỏ qua zone id (Node 24:
  // entry `fe80::1%eth0` khớp cả `fe80::1%eth1`), nên giới hạn theo interface operator gõ lặng lẽ
  // không có hiệu lực; bắt nó fail ngay lúc nạp config.
  if (ip.includes(IPV6_ZONE_SEPARATOR)) return false;
  const family = isIP(ip);
  if (family !== 4 && family !== 6) return false;
  if (prefixRaw === undefined) return true; // IP đơn = prefix đầy đủ, không phải /0
  if (!PREFIX_PATTERN.test(prefixRaw)) return false; // rỗng, chữ, khoảng trắng, dấu -
  const prefix = Number(prefixRaw);
  return prefix >= 1 && prefix <= MAX_PREFIX[family];
}

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
      .transform((s, ctx) => {
        const entries = s
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean);
        // Báo theo VỊ TRÍ (không lặp lại giá trị gõ sai trong message) để lỗi rõ ràng nhưng không
        // vô tình lặp lại một entry hỏng vào log/detail.
        entries.forEach((entry, index) => {
          if (!isValidAllowlistEntry(entry))
            ctx.addIssue({
              code: 'custom',
              message: `entry at index ${index} is not a valid IP or CIDR (a bare IP, or ip/prefix with prefix 1-32 for IPv4 / 1-128 for IPv6, no IPv6 zone id; "/0" is always rejected)`,
            });
        });
        return entries;
      })
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
