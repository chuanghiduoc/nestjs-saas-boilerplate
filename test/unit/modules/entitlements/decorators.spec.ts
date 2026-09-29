import { Controller, Get } from '@nestjs/common';
import { INTERCEPTORS_METADATA } from '@nestjs/common/constants.js';
import { Reflector } from '@nestjs/core';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { UNLIMITED } from '../../../../src/modules/entitlements/domain/feature-catalogue.js';
import {
  FeatureKindMismatchError,
  UnknownFeatureError,
} from '../../../../src/modules/entitlements/errors.js';
import { defineFeatureCatalogue } from '../../../../src/modules/entitlements/http/decorators.js';
import { EntitlementInterceptor } from '../../../../src/modules/entitlements/http/entitlement.interceptor.js';
import { FEATURE_REQUIREMENTS } from '../../../../src/modules/entitlements/http/feature-metadata.js';

const Cat = defineFeatureCatalogue({
  'x.flag': { kind: 'FLAG', fallback: false },
  'x.other': { kind: 'FLAG', fallback: true },
  'x.limit': { kind: 'LIMIT', fallback: UNLIMITED },
  'x.calls': { kind: 'QUOTA', resetPeriod: 'MONTH', fallback: { max: 1 } },
});
@Controller('v1/orgs/:orgId/x')
class Ctl {
  @Get() @Cat.requireEnabled('x.flag', 'x.other') read(this: void) {}
}
const r = new Reflector();

describe('defineFeatureCatalogue / requireEnabled (spec SP4 §6.4, §12.3, HT-0)', () => {
  it('records the catalogue object and keys and attaches EntitlementInterceptor', () => {
    expect(r.get(FEATURE_REQUIREMENTS, Ctl.prototype.read)).toEqual([
      { catalogue: Cat, keys: ['x.flag', 'x.other'] },
    ]);
    expect(r.get(INTERCEPTORS_METADATA, Ctl.prototype.read)).toContain(
      EntitlementInterceptor,
    );
  });
  it('only FLAG keys are accepted: a compile error, and a runtime error when types are bypassed', () => {
    expectTypeOf<Parameters<typeof Cat.requireEnabled>[0]>().toEqualTypeOf<
      'x.flag' | 'x.other'
    >();
    // @ts-expect-error 'x.limit' is a LIMIT
    expect(() => Cat.requireEnabled('x.limit')).toThrow(
      FeatureKindMismatchError,
    );
    expect(() => Reflect.apply(Cat.requireEnabled, Cat, ['x.calls'])).toThrow(
      FeatureKindMismatchError,
    );
    expect(() => Reflect.apply(Cat.requireEnabled, Cat, ['x.ghost'])).toThrow(
      UnknownFeatureError,
    );
  });
  it('key() is the identity with a typed parameter', () => {
    expect(Cat.key('x.limit')).toBe('x.limit');
    // @ts-expect-error not a key of the catalogue
    expect(Cat.key('x.ghost')).toBe('x.ghost');
    expect(Cat.keys).toEqual(['x.flag', 'x.other', 'x.limit', 'x.calls']);
  });
});
