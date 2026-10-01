import { describe, expect, it } from 'vitest';
import { isLapsed } from '../../../../src/modules/tenancy/domain/expiry.js';
import {
  INVITATION_STATUSES,
  effectiveInvitationStatus,
  transitionInvitation,
  type InvitationEvent,
} from '../../../../src/modules/tenancy/domain/invitation.js';

const EVENTS: readonly InvitationEvent[] = [
  'ACCEPT',
  'REVOKE',
  'EXPIRE',
  'INVALIDATE',
];
const TO = {
  ACCEPT: 'ACCEPTED',
  REVOKE: 'REVOKED',
  EXPIRE: 'EXPIRED',
  INVALIDATE: 'INVALIDATED',
} as const;

describe('invitation state machine (spec SP3 §9.1): every (status × event) pair', () => {
  for (const status of INVITATION_STATUSES)
    for (const event of EVENTS)
      it(`${status} --${event}-->`, () => {
        expect(transitionInvitation(status, event)).toEqual(
          status === 'PENDING'
            ? { ok: true, to: TO[event] }
            : { ok: false, reason: 'NOT_PENDING' },
        );
      });
  it('a PENDING invitation reads as EXPIRED at and after expires_at; other statuses never change', () => {
    const at = new Date('2026-10-01T00:00:00.000Z');
    expect(isLapsed(at, new Date(at.getTime() - 1))).toBe(false);
    expect(isLapsed(at, at)).toBe(true);
    expect(
      effectiveInvitationStatus({ status: 'PENDING', expiresAt: at }, at),
    ).toBe('EXPIRED');
    expect(
      effectiveInvitationStatus(
        { status: 'PENDING', expiresAt: at },
        new Date(at.getTime() - 1),
      ),
    ).toBe('PENDING');
    expect(
      effectiveInvitationStatus(
        { status: 'REVOKED', expiresAt: at },
        new Date(at.getTime() + 1),
      ),
    ).toBe('REVOKED');
  });
});
