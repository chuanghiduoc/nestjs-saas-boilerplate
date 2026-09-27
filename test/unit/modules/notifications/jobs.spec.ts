import { describe, expect, it } from 'vitest';
import { SendEmailJob } from '../../../../src/modules/notifications/jobs.js';

describe('notifications jobs', () => {
  it('send-email payload carries only the delivery id (no PII in Redis/Bull Board)', () => {
    expect(Object.keys(SendEmailJob.schema.shape)).toEqual(['deliveryId']);
    expect(
      SendEmailJob.schema.safeParse({
        deliveryId: '019dd1a5-9235-70db-8d57-54ef901d8185',
        to: 'a@b.c',
      }).success,
    ).toBe(false);
  });
});
