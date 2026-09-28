import { describe, expect, it } from 'vitest';
import { unwrapIPv4Mapped } from '../../../../src/core/queue/dashboard/queue-dashboard.server.js';

describe('unwrapIPv4Mapped', () => {
  it('unwraps an IPv4-mapped IPv6 address to its IPv4 form', () => {
    expect(unwrapIPv4Mapped('::ffff:127.0.0.1')).toBe('127.0.0.1');
    expect(unwrapIPv4Mapped('::FFFF:10.0.0.5')).toBe('10.0.0.5');
  });

  it('leaves a plain IPv4 address untouched', () => {
    expect(unwrapIPv4Mapped('10.0.0.1')).toBe('10.0.0.1');
  });

  it('leaves a non-mapped IPv6 address untouched', () => {
    expect(unwrapIPv4Mapped('::1')).toBe('::1');
    expect(unwrapIPv4Mapped('2001:db8::1')).toBe('2001:db8::1');
  });

  it('leaves an empty address untouched (denied by the allowlist regardless)', () => {
    expect(unwrapIPv4Mapped('')).toBe('');
  });
});
