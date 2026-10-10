import { describe, expect, it } from 'vitest';
import {
  transitionEndpoint,
  urlHost,
  type EndpointEvent,
  type EndpointState,
} from '../../../../src/modules/integrations/domain/webhook-endpoint.js';

const ACTIVE: EndpointState = { status: 'ACTIVE' };
const MANUAL: EndpointState = { status: 'DISABLED', reason: 'MANUAL' };
const AUTO: EndpointState = { status: 'DISABLED', reason: 'AUTO_FAILING' };
const E = (kind: EndpointEvent['kind']): EndpointEvent => ({ kind });

describe('webhook endpoint state machine (spec SP6 §7.3)', () => {
  it.each([
    [ACTIVE, 'DISABLE', { kind: 'CHANGED', to: MANUAL }],
    [ACTIVE, 'AUTO_DISABLE', { kind: 'CHANGED', to: AUTO }],
    [ACTIVE, 'ENABLE', { kind: 'UNCHANGED' }],
    [MANUAL, 'ENABLE', { kind: 'CHANGED', to: ACTIVE }],
    [AUTO, 'ENABLE', { kind: 'CHANGED', to: ACTIVE }],
    [MANUAL, 'DISABLE', { kind: 'UNCHANGED' }],
    [AUTO, 'DISABLE', { kind: 'UNCHANGED' }],
    [MANUAL, 'AUTO_DISABLE', { kind: 'UNCHANGED' }],
    [AUTO, 'AUTO_DISABLE', { kind: 'UNCHANGED' }],
  ] as const)('%j × %s', (from, kind, want) => {
    expect(transitionEndpoint(from, E(kind))).toEqual(want);
  });
  it('urlHost keeps only the host (path, query and credentials never reach an event)', () => {
    expect(urlHost('https://hooks.example.test:8443/a/b?token=secret')).toBe(
      'hooks.example.test',
    );
    expect(urlHost('https://[2001:db8::1]/x')).toBe('[2001:db8::1]');
  });
});
