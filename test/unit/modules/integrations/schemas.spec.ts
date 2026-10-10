import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { WEBHOOK_EVENT_TYPES_MAX } from '../../../../src/modules/integrations/constants.js';

describe('webhook endpoint schemas (review 6C M7)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });
  it('eventTypes maxItems is WEBHOOK_EVENT_TYPES_MAX even when the runtime cap is lowered by env', async () => {
    vi.stubEnv('INTEGRATIONS_MAX_EVENT_TYPES_PER_ENDPOINT', '2');
    vi.resetModules();
    const { CreateEndpointBody } =
      await import('../../../../src/modules/integrations/http/schemas.js');
    for (const s of [CreateEndpointBody])
      expect(z.toJSONSchema(s, { io: 'input' })).toMatchObject({
        properties: { eventTypes: { maxItems: WEBHOOK_EVENT_TYPES_MAX } },
      });
  });
});
