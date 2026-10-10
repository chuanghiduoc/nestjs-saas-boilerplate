import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../../../../src/core/database/index.js';
import '../../../../src/modules/tenancy/events.js';
import { WebhookEventCatalogueCheck } from '../../../../src/modules/integrations/application/event-catalogue-check.js';
import { IntegrationsMetrics } from '../../../../src/modules/integrations/application/integrations-metrics.js';

/** Sáu event `webhook: true` của tenancy (6.0 đặt cờ): nạp `tenancy/events.ts` ở trên. */
const SIX = [
  'tenancy.member.added',
  'tenancy.member.removed',
  'tenancy.member.role_changed',
  'tenancy.org.deleted',
  'tenancy.org.restored',
  'tenancy.org.updated',
];
const dbWith = (types: string[]): Db => {
  const execute = vi.fn(async () => types.map((type) => ({ type })));
  // Db chỉ cần `execute` ở đây; ép qua Pick để không giả toàn bộ lớp (không có `any`).
  return { execute } as Pick<Db, 'execute'> as Db;
};
const eventOf = (call: unknown[]): unknown =>
  typeof call[0] === 'object' && call[0] !== null && 'event' in call[0]
    ? call[0].event
    : undefined;
const check = (types: string[]) =>
  new WebhookEventCatalogueCheck(dbWith(types), new IntegrationsMetrics());

describe('WebhookEventCatalogueCheck (spec SP6 §6.5, R-X30, W-43 boot part)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('passes when every webhook:true type has a row; known() and definitions() list the code types', async () => {
    const c = check(SIX);
    await expect(c.onModuleInit()).resolves.toBeUndefined();
    expect([...c.known()].sort()).toEqual(SIX);
    expect(c.definitions().map((d) => d.type)).toEqual([...SIX].sort());
  });
  it('refuses to boot when a webhook:true type is missing, naming it and logging webhook_event_catalogue_mismatch', async () => {
    const error = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    await expect(
      check(SIX.filter((t) => t !== 'tenancy.org.restored')).onModuleInit(),
    ).rejects.toThrow('missing in webhook_event_types: tenancy.org.restored');
    expect(error.mock.calls.map(eventOf)).toContain(
      'webhook_event_catalogue_mismatch',
    );
  });
  it('a row unknown to this code only warns, once (R-X30: newer DB, rolling deploy, or its module is disabled)', async () => {
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const c = check([...SIX, 'files.file.ready']);
    await expect(c.onModuleInit()).resolves.toBeUndefined();
    expect(warn.mock.calls.map(eventOf)).toEqual([
      'webhook_event_types_unknown_to_code',
    ]);
    expect(c.known().has('files.file.ready')).toBe(false);
  });
  it('known() before the check ran is a wiring bug and throws', () => {
    expect(() => check(SIX).known()).toThrow(/before onModuleInit/);
  });
});
