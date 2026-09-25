import { BlockList, isIPv4, isIPv6 } from 'node:net';

/** Giá trị hợp lệ cho Express "trust proxy": boolean, số hop, hoặc danh sách địa chỉ/CIDR/tên preset. */
export function parseTrustProxy(raw: string): boolean | number | string[] {
  const v = raw.trim();
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^\d+$/.test(v)) return Number(v);
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Tên preset mà `proxy-addr` (Express) hiểu. */
export const TRUST_PROXY_PRESETS = [
  'loopback',
  'linklocal',
  'uniquelocal',
] as const;

/**
 * Dải rộng hơn các ngưỡng này không thể là dải của proxy nội bộ; tin chúng gần như tin mọi client
 * (ai cũng giả được X-Forwarded-For). IPv6 `/32` là cỡ cấp phát cho cả một ISP.
 */
const MIN_IPV4_PREFIX = 8;
const MIN_IPV6_PREFIX = 32;
/** Khối IPv4-mapped `::ffff:0:0/96` (proxy-addr so khớp địa chỉ IPv4 với dải này). */
const IPV4_MAPPED_BLOCK = { address: '::ffff:0:0', prefix: 96 } as const;

const ipv6Subnet = (address: string, prefix: number): BlockList => {
  const list = new BlockList();
  list.addSubnet(address, prefix, 'ipv6');
  return list;
};
const IPV4_MAPPED = ipv6Subnet(
  IPV4_MAPPED_BLOCK.address,
  IPV4_MAPPED_BLOCK.prefix,
);

function isBroadRange(entry: string): boolean {
  const [address, rawPrefix] = entry.split('/');
  if (!address || rawPrefix === undefined) return false;
  const prefix = Number(rawPrefix);
  if (isIPv4(address)) return prefix < MIN_IPV4_PREFIX;
  if (!isIPv6(address)) return false;
  if (prefix < MIN_IPV6_PREFIX) return true;
  // Chứa toàn bộ khối IPv4-mapped, hoặc là một dải IPv4-mapped rộng hơn /8.
  if (
    prefix < IPV4_MAPPED_BLOCK.prefix &&
    ipv6Subnet(address, prefix).check(IPV4_MAPPED_BLOCK.address, 'ipv6')
  )
    return true;
  return (
    prefix < IPV4_MAPPED_BLOCK.prefix + MIN_IPV4_PREFIX &&
    IPV4_MAPPED.check(address, 'ipv6')
  );
}

/** Nhận giá trị đã parse của config (kiểu `unknown` vì luật config đọc bản ghi không định kiểu). */
export const trustsEveryProxy = (v: unknown): boolean =>
  v === true ||
  (Array.isArray(v) && v.some((a) => typeof a === 'string' && isBroadRange(a)));
