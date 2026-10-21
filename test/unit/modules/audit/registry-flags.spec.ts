import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AUDITED_EVENTS,
  WEBHOOK_EVENTS,
  eventRegistry,
} from '../../../../src/core/events/index.js';
// Nạp mọi module như composition (đăng ký mọi defineEvent).
import '../../../../src/modules/notifications/index.js';
import '../../../../src/modules/identity/index.js';
import '../../../../src/modules/tenancy/index.js';
import '../../../../src/modules/entitlements/index.js';
import '../../../../src/modules/integrations/index.js';
import '../../../../src/modules/audit/index.js';

/** Event mang lý do tự do của nhân viên (R-X31): không bao giờ ra webhook. */
const STAFF_REASON_EVENTS = [
  'entitlements.override.set',
  'entitlements.override.removed',
  'entitlements.plan.changed',
];

describe('event flags seen by the audit sink (spec SP6 §5.3, R-X3, R-X31)', () => {
  it('every audited event has an object schema (data is a JSON object, audit_logs_data_ck)', () => {
    const audited = eventRegistry().filter((d) => AUDITED_EVENTS.matches(d));
    expect(audited.length).toBeGreaterThan(0);
    for (const def of audited)
      expect(
        def.schema instanceof z.ZodObject,
        `${def.type}@${def.version}`,
      ).toBe(true);
  });
  it('no audit.* or identity.* event is a webhook event: the audit sink never fans out', () => {
    const own = eventRegistry().filter((d) =>
      /^(audit|identity)\./.test(d.type),
    );
    expect(own.map((d) => d.type)).toContain('audit.staff_access.recorded');
    for (const def of own)
      expect(WEBHOOK_EVENTS.matches(def), def.type).toBe(false);
  });
  it('events carrying a staff reason are audited and never webhooks (R-X31)', () => {
    for (const type of STAFF_REASON_EVENTS) {
      const defs = eventRegistry().filter((d) => d.type === type);
      expect(defs.length, type).toBeGreaterThan(0);
      for (const d of defs)
        expect({ audit: d.audit, webhook: d.webhook }).toEqual({
          audit: true,
          webhook: false,
        });
    }
  });
});
