import type { CredentialKind } from '../../../core/context/index.js';

/** Addendum A3: một lần truy cập mà gate nhân viên đã cho qua; chỉ path param, không query/body (A-D5). */
export type PlatformAccessEntry = {
  readonly method: string;
  readonly routeTemplate: string;
  readonly params: Readonly<Record<string, string>>;
  readonly actor: { readonly type: 'user'; readonly id: string };
  readonly credentialKind: Extract<
    CredentialKind,
    'SESSION_COOKIE' | 'BEARER_SESSION' | 'EXTERNAL_COOKIE' | 'EXTERNAL_BEARER'
  >;
};

/**
 * Port audit truy cập route quyền nền tảng (addendum A3; SP6 6B cài). `@Global` + `@Optional`: identity KHÔNG đăng ký
 * provider (A-D4); vắng → `NOOP_PLATFORM_ACCESS_AUDIT`. `record` chỉ trả về sau khi bản ghi đã bền; ném → guard 503.
 */
export abstract class PlatformAccessAudit {
  abstract record(entry: PlatformAccessEntry): Promise<void>;
}
export class NoopPlatformAccessAudit extends PlatformAccessAudit {
  record(): Promise<void> {
    return Promise.resolve();
  }
}
export const NOOP_PLATFORM_ACCESS_AUDIT = new NoopPlatformAccessAudit();
