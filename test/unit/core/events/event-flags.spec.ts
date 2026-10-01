import { describe, expect, it } from 'vitest';
import { z } from 'zod';
// Nạp đủ module của app: mọi `defineEvent` chạy lúc import. `app.modules.ts` là danh sách module chung của api và worker;
// không import `app-api.module`/`app-worker.module` cùng lúc: mỗi file gọi `DatabaseModule.forRoot()` lúc import và
// `@mikro-orm/nestjs` ném `ContextName 'app' already registered` ở lần thứ hai.
import '../../../../src/app.modules.js';
import {
  defineEvent,
  eventRegistry,
} from '../../../../src/core/events/index.js';

/**
 * Giá trị cuối của cờ cho event có trên `main` khi 6.0 merge (spec SP6 §5.3 hàng "Mọi lời gọi defineEvent", §8.3). Plan W2
 * merge TRƯỚC 6.0 (3B, 4A) thì 6.0 thêm event của họ vào đây lúc rebase (Task 16 Step 2, "Bảng sửa code của plan trước").
 * Plan merge SAU 6.0 KHÔNG sửa bảng này: event mới tự khai cờ theo spec của mình (compile bắt); ca đầu kiểm kiểu cho mọi
 * event, ca "audited namespaces" ép giá trị cho mọi `tenancy.*`/`entitlements.*` bất kể thứ tự merge.
 */
const EXPECTED: Readonly<Record<string, { audit: boolean; webhook: boolean }>> =
  {
    'identity.user.registered@1': { audit: true, webhook: false },
    'notifications.delivery.failed@1': { audit: false, webhook: false },
    'tenancy.org.created@1': { audit: true, webhook: false },
    'tenancy.org.updated@1': { audit: true, webhook: true },
    'tenancy.org.deleted@1': { audit: true, webhook: true },
    'tenancy.org.restored@1': { audit: true, webhook: true },
    'tenancy.org.purged@1': { audit: true, webhook: false },
    'tenancy.member.added@1': { audit: true, webhook: true },
    'tenancy.member.role_changed@1': { audit: true, webhook: true },
    'tenancy.member.removed@1': { audit: true, webhook: true },
  };
const flagsOf = () =>
  new Map(
    eventRegistry().map((d) => [
      `${d.type}@${d.version}`,
      { audit: d.audit, webhook: d.webhook },
    ]),
  );

describe('event flags audit/webhook (R-X3, spec SP6 §5.3, C-1)', () => {
  it('every event the app defines declares both flags as booleans', () => {
    const defs = eventRegistry();
    expect(defs.length).toBeGreaterThanOrEqual(Object.keys(EXPECTED).length);
    for (const d of defs)
      expect(
        [typeof d.audit, typeof d.webhook],
        `${d.type}@${d.version}`,
      ).toEqual(['boolean', 'boolean']);
  });
  it.each(Object.entries(EXPECTED))(
    '%s carries its final flags',
    (key, flags) => {
      expect(flagsOf().get(key)).toEqual(flags);
    },
  );
  it('exactly six tenancy events of 3A are public webhook contracts (spec SP6 §8.3)', () => {
    expect(
      [...flagsOf()]
        .filter(([key, f]) => key.startsWith('tenancy.') && f.webhook)
        .map(([key]) => key)
        .sort(),
    ).toEqual(
      [
        'tenancy.member.added@1',
        'tenancy.member.removed@1',
        'tenancy.member.role_changed@1',
        'tenancy.org.deleted@1',
        'tenancy.org.restored@1',
        'tenancy.org.updated@1',
      ].sort(),
    );
  });
  it('audited namespaces: every tenancy.* and entitlements.* event is audited; no entitlements.* event is a webhook (SP3 §14 update, SP6 §18.4, SP4 S4-D20)', () => {
    // Giữ cờ của event 3B (`tenancy.role.*`) và 4A (`entitlements.*`) đúng spec dù plan đó merge trước hay sau 6.0; tập webhook
    // của `tenancy.*` đã bị ca "exactly six" ở trên khoá.
    for (const [key, f] of flagsOf()) {
      if (key.startsWith('tenancy.') || key.startsWith('entitlements.'))
        expect(f.audit, key).toBe(true);
      if (key.startsWith('entitlements.')) expect(f.webhook, key).toBe(false);
    }
  });
  it('missing flags are a compile error; a non-boolean flag coming from JS throws at definition', () => {
    const missing = () =>
      // @ts-expect-error audit and webhook are required, there is no default (R-X3)
      defineEvent({
        type: 'unit.flags.missing',
        version: 1,
        schema: z.object({}),
      });
    expect(missing).toThrow(/must declare audit and webhook as booleans/);
    const fromJs: unknown = {
      type: 'unit.flags.stringy',
      version: 1,
      schema: z.object({}),
      audit: 'true',
      webhook: false,
    };
    expect(() => Reflect.apply(defineEvent, undefined, [fromJs])).toThrow(
      /must declare audit and webhook as booleans/,
    );
    const kept = defineEvent({
      type: 'unit.flags.kept',
      version: 1,
      schema: z.object({}),
      audit: true,
      webhook: false,
    });
    expect([kept.audit, kept.webhook]).toEqual([true, false]);
  });
});
