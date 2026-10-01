import { randomUUID } from 'node:crypto';
import * as sdk from '@openfeature/server-sdk';
import {
  NOOP_PROVIDER,
  OpenFeature,
  ProviderStatus,
  StandardResolutionReasons,
  TypeMismatchError,
  type JsonValue,
  type Provider,
  type ResolutionDetails,
} from '@openfeature/server-sdk';
import { describe, expect, it } from 'vitest';

/** Provider thăm dò: đếm initialize/onClose, chỉ trả boolean (như DbKillSwitchProvider của Task 9). */
class ProbeProvider implements Provider {
  readonly metadata = { name: 'probe' };
  readonly runsOn = 'server';
  initialized = 0;
  closed = 0;
  constructor(
    private readonly value: boolean,
    private readonly failInit = false,
  ) {}
  async initialize(): Promise<void> {
    this.initialized++;
    if (this.failInit) throw new Error('first load failed');
  }
  async onClose(): Promise<void> {
    this.closed++;
  }
  resolveBooleanEvaluation(
    flagKey: string,
    defaultValue: boolean,
  ): Promise<ResolutionDetails<boolean>> {
    return Promise.resolve(
      flagKey === 'probe.on'
        ? { value: this.value, reason: StandardResolutionReasons.CACHED }
        : { value: defaultValue, reason: StandardResolutionReasons.DEFAULT },
    );
  }
  resolveStringEvaluation(): Promise<ResolutionDetails<string>> {
    return Promise.reject(new TypeMismatchError('boolean flags only'));
  }
  resolveNumberEvaluation(): Promise<ResolutionDetails<number>> {
    return Promise.reject(new TypeMismatchError('boolean flags only'));
  }
  resolveObjectEvaluation<T extends JsonValue>(): Promise<
    ResolutionDetails<T>
  > {
    return Promise.reject(new TypeMismatchError('boolean flags only'));
  }
}
const domain = () => `contract.${randomUUID()}`;

/**
 * Spike P3 của spec SP6 §4, giữ lại làm test hợp đồng: nâng `@openfeature/*` mà đổi bất kỳ điều nào dưới đây thì
 * test đỏ trước khi kill switch âm thầm đổi nghĩa (core/flags, Task 9).
 */
describe('@openfeature/server-sdk 1.23.0 contract (spike P3)', () => {
  it('loads as ESM under SWC with the API core/flags uses', () => {
    for (const name of [
      'OpenFeature',
      'NOOP_PROVIDER',
      'ProviderStatus',
      'StandardResolutionReasons',
      'TypeMismatchError',
    ])
      expect(name in sdk, name).toBe(true);
    expect(typeof OpenFeature.setLogger).toBe('function');
    expect(typeof OpenFeature.close).toBe('function');
  });
  it('setProviderAndWait on a domain runs initialize once; the client of that domain is READY and resolves booleans', async () => {
    const d = domain();
    const p = new ProbeProvider(true);
    await OpenFeature.setProviderAndWait(d, p);
    const client = OpenFeature.getClient(d);
    expect([p.initialized, client.providerStatus]).toEqual([
      1,
      ProviderStatus.READY,
    ]);
    expect(await client.getBooleanValue('probe.on', false)).toBe(true);
    expect(await client.getBooleanValue('probe.missing', false)).toBe(false);
    await OpenFeature.setProviderAndWait(d, NOOP_PROVIDER);
  });
  it('two domains in one process are isolated (one provider per Nest app in tests)', async () => {
    const [a, b] = [domain(), domain()];
    await OpenFeature.setProviderAndWait(a, new ProbeProvider(true));
    await OpenFeature.setProviderAndWait(b, new ProbeProvider(false));
    expect(
      await OpenFeature.getClient(a).getBooleanValue('probe.on', false),
    ).toBe(true);
    expect(
      await OpenFeature.getClient(b).getBooleanValue('probe.on', true),
    ).toBe(false);
    await OpenFeature.setProviderAndWait(a, NOOP_PROVIDER);
    await OpenFeature.setProviderAndWait(b, NOOP_PROVIDER);
  });
  it('an initialize failure rejects setProviderAndWait and leaves the client in ERROR (fail loud at boot)', async () => {
    const d = domain();
    await expect(
      OpenFeature.setProviderAndWait(d, new ProbeProvider(true, true)),
    ).rejects.toThrow('first load failed');
    expect(OpenFeature.getClient(d).providerStatus).toBe(ProviderStatus.ERROR);
    await OpenFeature.setProviderAndWait(d, NOOP_PROVIDER);
  });
  it('replacing the provider of a domain with NOOP_PROVIDER calls onClose of the old one', async () => {
    const d = domain();
    const p = new ProbeProvider(true);
    await OpenFeature.setProviderAndWait(d, p);
    await OpenFeature.setProviderAndWait(d, NOOP_PROVIDER);
    expect(p.closed).toBe(1);
  });
  it('OpenFeature.close() calls onClose of every domain provider', async () => {
    const d = domain();
    const p = new ProbeProvider(true);
    await OpenFeature.setProviderAndWait(d, p);
    await OpenFeature.close();
    expect(p.closed).toBe(1);
  });
  it('a non-boolean evaluation against a boolean-only provider returns the default (why KillSwitches only asks booleans)', async () => {
    const d = domain();
    await OpenFeature.setProviderAndWait(d, new ProbeProvider(true));
    expect(
      await OpenFeature.getClient(d).getStringValue('probe.on', 'fallback'),
    ).toBe('fallback');
    await OpenFeature.setProviderAndWait(d, NOOP_PROVIDER);
  });
});
