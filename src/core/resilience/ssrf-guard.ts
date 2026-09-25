import { lookup as dnsLookup } from 'node:dns';
import { isIP, type LookupFunction } from 'node:net';
import ipaddr from 'ipaddr.js';

export type SsrfConfig = {
  allowedSchemes: readonly string[];
  allowedPorts: readonly number[];
  allowCidrs: readonly string[];
};
export type Cidr = [ipaddr.IPv4 | ipaddr.IPv6, number];

/** Chỉ range `unicast` của ipaddr.js là công khai; mọi range khác (loopback, private, linkLocal, CGNAT, 6to4, NAT64...) bị chặn. */
const PUBLIC_RANGE = 'unicast';
/** Global unicast của IANA; IPv6 ngoài khoảng này luôn bị chặn trừ khi nằm trong allowlist. */
const GLOBAL_UNICAST_V6 = ipaddr.parseCIDR('2000::/3');
const DEFAULT_PORT: Readonly<Record<string, number>> = {
  'http:': 80,
  'https:': 443,
};

/** Quyết định chính sách (không phải lỗi tạm thời): không retry, không tính vào breaker. Message chỉ log ở server. */
export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfBlockedError';
  }
}

/** Endpoint metadata của cloud (AWS/GCP/Azure IPv4, AWS IPv6): allowlist không bao giờ được phủ lên. */
const CLOUD_METADATA = ['169.254.169.254', 'fd00:ec2::254'].map((ip) =>
  ipaddr.parse(ip),
);

/** Lý do một entry allowlist bị từ chối (undefined nếu hợp lệ). Dùng khi validate config. */
export function allowCidrProblem(cidr: string): string | undefined {
  if (!ipaddr.isValidCIDR(cidr)) return 'is not a valid CIDR';
  const [range, bits] = ipaddr.parseCIDR(cidr);
  if (bits === 0) return 'has prefix length 0 (disables the SSRF guard)';
  // isPublicAddress chuyển IPv4-mapped về IPv4 trước khi so, nên CIDR dạng ::ffff:a.b.c.d/n không bao giờ khớp.
  if (range instanceof ipaddr.IPv6 && range.isIPv4MappedAddress())
    return 'is IPv4-mapped IPv6 and would never match; use the IPv4 form';
  if (
    CLOUD_METADATA.some(
      (m) => m.kind() === range.kind() && m.match(range, bits),
    )
  )
    return 'covers the cloud metadata endpoint';
  return undefined;
}

export const parseCidrs = (cidrs: readonly string[]): Cidr[] =>
  cidrs.map((c) => ipaddr.parseCIDR(c));

/** Chỉ địa chỉ unicast công khai (sau khi bỏ lớp IPv4-mapped/compat) hoặc nằm trong allowlist. */
export function isPublicAddress(ip: string, allow: readonly Cidr[]): boolean {
  if (!ipaddr.isValid(ip)) return false;
  const addr = ipaddr.process(ip);
  if (
    allow.some(
      ([range, bits]) =>
        addr.kind() === range.kind() && addr.match(range, bits),
    )
  )
    return true;
  if (addr.range() !== PUBLIC_RANGE) return false;
  // ipaddr xếp mọi khoảng IPv6 "chưa biết" (kể cả IPv4-compatible ::/96 như ::7f00:1, ::a9fe:a9fe) là
  // 'unicast'; trên host có tunnel sit, ::/96 đi thẳng tới IPv4 đích. Nên IPv6 phải nằm trong 2000::/3.
  return addr.kind() === 'ipv4' || addr.match(GLOBAL_UNICAST_V6);
}

/** Kiểm tra URL trước khi kết nối. Host là tên miền thì kiểm tra IP ở `ssrfLookup` lúc connect. */
export function assertUrlAllowed(url: URL, cfg: SsrfConfig): void {
  const scheme = url.protocol.slice(0, -1);
  const port = url.port ? Number(url.port) : DEFAULT_PORT[url.protocol];
  if (!cfg.allowedSchemes.includes(scheme) || port === undefined)
    throw new SsrfBlockedError(`URL scheme ${url.protocol} is not allowed`);
  if (url.username || url.password)
    throw new SsrfBlockedError('URL credentials (userinfo) are not allowed');
  if (!cfg.allowedPorts.includes(port))
    throw new SsrfBlockedError(`Destination port ${port} is not allowed`);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  // net.connect không gọi lookup cho IP literal (net.isIP), nên IP literal phải bị chặn ở đây.
  // Kiểm tra theo cả net.isIP lẫn ipaddr để không có dạng nào lọt qua giữa hai bộ parse.
  if (
    (isIP(host) !== 0 || ipaddr.isValid(host)) &&
    !isPublicAddress(host, parseCidrs(cfg.allowCidrs))
  )
    throw new SsrfBlockedError(`Destination ${host} is not allowed`);
}

/**
 * `lookup` cho net.connect/tls.connect: resolve DNS rồi chặn nếu **bất kỳ** địa chỉ nào không công khai.
 * IP được kiểm tra chính là IP socket kết nối tới (chống DNS rebinding, không có bước resolve trước).
 * Node gọi với `{ all: true }` khi autoSelectFamily bật (mặc định) và nhận lại cả mảng đã kiểm tra.
 */
export function ssrfLookup(allowCidrs: readonly string[]): LookupFunction {
  const allow = parseCidrs(allowCidrs);
  return (hostname, options, callback) => {
    dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, []);
      const blocked = addresses.find((a) => !isPublicAddress(a.address, allow));
      if (blocked)
        return callback(
          new SsrfBlockedError(
            `Destination ${hostname} (${blocked.address}) is not allowed`,
          ),
          [],
        );
      const first = addresses[0];
      if (!first)
        return callback(
          new SsrfBlockedError(`Destination ${hostname} did not resolve`),
          [],
        );
      if (options.all) return callback(null, addresses);
      callback(null, first.address, first.family);
    });
  };
}
