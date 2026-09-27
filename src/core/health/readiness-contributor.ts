import { DiscoveryService } from '@nestjs/core';

/** Phụ thuộc do module sở hữu (vd. pool `auth_user` của identity); `core` không import module. */
export interface ReadinessProbe {
  probe(): Promise<void>;
}

export const ReadinessContributorMarker =
  DiscoveryService.createDecorator<string>();

/** Gắn lên provider singleton cài `ReadinessProbe`; `key` là tên indicator trong kết quả ready. */
export const ReadinessContributor = (key: string): ClassDecorator =>
  ReadinessContributorMarker(key);

export const isReadinessProbe = (v: unknown): v is ReadinessProbe =>
  typeof v === 'object' &&
  v !== null &&
  'probe' in v &&
  typeof v.probe === 'function';
