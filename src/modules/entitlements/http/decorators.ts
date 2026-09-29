import { SetMetadata, UseInterceptors, applyDecorators } from '@nestjs/common';
import {
  featureCatalogueData,
  type FeatureCatalogueData,
  type FeatureCatalogueDef,
  type FeatureDef,
} from '../domain/feature-catalogue.js';
import { FeatureKindMismatchError, UnknownFeatureError } from '../errors.js';
import { EntitlementInterceptor } from './entitlement.interceptor.js';
import {
  FEATURE_REQUIREMENTS,
  type FeatureRequirement,
} from './feature-metadata.js';

export type FeatureKey<D extends FeatureCatalogueDef> = Extract<
  keyof D,
  string
>;
export type FlagKey<D extends FeatureCatalogueDef> = {
  [K in FeatureKey<D>]: D[K] extends { readonly kind: 'FLAG' } ? K : never;
}[FeatureKey<D>];
export type FeatureCatalogue<
  D extends FeatureCatalogueDef = FeatureCatalogueDef,
> = FeatureCatalogueData<D> & {
  /** Helper có kiểu cho `Entitlements.isEnabled(Cat.key('x.y'))`: gõ sai key là lỗi compile. */
  key<K extends FeatureKey<D>>(this: void, key: K): K;
  /** Mọi key phải bật; chỉ key FLAG (lỗi compile, và lỗi runtime khi kiểu bị vượt qua). */
  requireEnabled(
    this: void,
    ...keys: [FlagKey<D>, ...FlagKey<D>[]]
  ): MethodDecorator & ClassDecorator;
};

/**
 * Catalogue tính năng của một module/feature (spec §8.1, S4-D1). Metadata mang chính đối tượng catalogue để route
 * inventory kiểm nó đã đăng ký. Đặt ở `http/` vì cần `EntitlementInterceptor` (luật `domain-pure`).
 */
export function defineFeatureCatalogue<const D extends FeatureCatalogueDef>(
  features: D,
): FeatureCatalogue<D> {
  const catalogue: FeatureCatalogue<D> = {
    ...featureCatalogueData(features),
    key: (key) => key,
    requireEnabled: (...keys) => {
      for (const key of keys) {
        const def: FeatureDef | undefined = features[key];
        if (def === undefined) throw new UnknownFeatureError(key);
        if (def.kind !== 'FLAG')
          throw new FeatureKindMismatchError(key, 'FLAG', def.kind);
      }
      const requirement: FeatureRequirement = { catalogue, keys };
      return applyDecorators(
        SetMetadata(FEATURE_REQUIREMENTS, [requirement]),
        UseInterceptors(EntitlementInterceptor),
      );
    },
  };
  return catalogue;
}
