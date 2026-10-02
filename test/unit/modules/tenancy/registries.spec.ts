import { Injectable, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import {
  OrgPurgeParticipantContributor,
  OrgPurgeParticipantRegistry,
} from '../../../../src/modules/tenancy/application/org-purge-participant.registry.js';
import {
  PermissionCatalogueContributor,
  PermissionCatalogueRegistry,
} from '../../../../src/modules/tenancy/application/permission-catalogue.registry.js';
import {
  CatalogueError,
  defineCatalogue,
} from '../../../../src/modules/tenancy/domain/catalogue.js';
import { ORG_PURGE_STATEMENTS } from '../../../../src/modules/tenancy/infra/sql/org-purge.sql.js';
import { OrgPurgeParticipant } from '../../../../src/modules/tenancy/ports/org-purge-participant.js';

const entry = {
  requires: [],
  ownerOnly: false,
  apiKeyEligible: false,
  supportEligible: false,
  grantTo: { admin: true, member: false },
};
const A = defineCatalogue('a', {
  'alpha.read': { resource: 'alpha', action: 'read', ...entry },
});
const B = defineCatalogue('b', {
  'beta.read': { resource: 'beta', action: 'read', ...entry },
});
const B2 = defineCatalogue('b2', {
  'beta.read': { resource: 'beta', action: 'read', ...entry },
});

@Injectable()
@PermissionCatalogueContributor(A)
class ContribA {}
@Injectable()
@PermissionCatalogueContributor(B)
class ContribB {}
@Injectable()
@PermissionCatalogueContributor(B2)
class ContribB2 {}
@Injectable()
@PermissionCatalogueContributor(A)
class ContribAAgain {}
@Module({ providers: [ContribA] })
class ModA {}
@Module({ providers: [ContribB] })
class ModB {}
@Module({ providers: [ContribB2] })
class ModB2 {}

@Injectable()
@OrgPurgeParticipantContributor({ key: 'second', order: 10 })
class Second extends OrgPurgeParticipant {
  purge(): Promise<void> {
    return Promise.resolve();
  }
}
@Injectable()
@OrgPurgeParticipantContributor({ key: 'first', order: 0 })
class First extends OrgPurgeParticipant {
  purge(): Promise<void> {
    return Promise.resolve();
  }
}
@Injectable()
@OrgPurgeParticipantContributor({ key: 'first', order: 5 })
class FirstAgain extends OrgPurgeParticipant {
  purge(): Promise<void> {
    return Promise.resolve();
  }
}
@Injectable()
@OrgPurgeParticipantContributor({ key: 'broken', order: 1 })
class NotAParticipant {}
@Injectable()
@OrgPurgeParticipantContributor({ key: 'zeta', order: 3 })
class Zeta extends OrgPurgeParticipant {
  purge(): Promise<void> {
    return Promise.resolve();
  }
}
@Injectable()
@OrgPurgeParticipantContributor({ key: 'alpha', order: 3 })
class Alpha extends OrgPurgeParticipant {
  purge(): Promise<void> {
    return Promise.resolve();
  }
}
@Injectable()
@OrgPurgeParticipantContributor({ key: 'core-slot', order: 1000 })
class TakesCoreSlot extends OrgPurgeParticipant {
  purge(): Promise<void> {
    return Promise.resolve();
  }
}
@Injectable()
@OrgPurgeParticipantContributor({ key: 'negative', order: -1 })
class NegativeOrder extends OrgPurgeParticipant {
  purge(): Promise<void> {
    return Promise.resolve();
  }
}
@Module({ providers: [Second] })
class ModP1 {}
@Module({ providers: [First] })
class ModP2 {}

const boot = async (
  imports: Parameters<typeof Test.createTestingModule>[0]['imports'],
) => {
  const ref = await Test.createTestingModule({
    imports: [DiscoveryModule, ...(imports ?? [])],
    providers: [PermissionCatalogueRegistry, OrgPurgeParticipantRegistry],
  }).compile();
  await ref.init();
  return ref;
};

describe('Discovery registries across modules (spec SP3 §8.2, §18.3 "cơ chế Discovery hai module")', () => {
  it('merges catalogues contributed by two modules and knows their identity', async () => {
    const ref = await boot([ModA, ModB]);
    const reg = ref.get(PermissionCatalogueRegistry);
    expect([...reg.merged().keys()].sort()).toEqual([
      'alpha.read',
      'beta.read',
    ]);
    expect([reg.has(A), reg.has(B), reg.has(B2)]).toEqual([true, true, false]);
    await ref.close();
  });
  it('the merged catalogue is built on first use, independent of provider init order', async () => {
    const ref = await Test.createTestingModule({
      imports: [DiscoveryModule, ModA],
      providers: [PermissionCatalogueRegistry],
    }).compile();
    const reg = ref.get(PermissionCatalogueRegistry);
    expect([...reg.merged().keys()]).toEqual(['alpha.read']);
    expect(reg.has(A)).toBe(true);
    await ref.close();
  });
  it('the same catalogue contributed by two providers refuses to boot', async () => {
    await expect(
      boot([ModA, { module: class AAgain {}, providers: [ContribAAgain] }]),
    ).rejects.toThrow(
      /Permission catalogue "a" is contributed twice \(ContribA, ContribAAgain\)/,
    );
  });
  it('two catalogues with the same key refuse to boot', async () => {
    await expect(boot([ModB, ModB2])).rejects.toBeInstanceOf(CatalogueError);
  });
  it('participants from two modules run by order then key', async () => {
    const ref = await boot([ModP1, ModP2]);
    expect(
      ref
        .get(OrgPurgeParticipantRegistry)
        .participants()
        .map((p) => p.key),
    ).toEqual(['first', 'second']);
    await ref.close();
  });
  it('participants with the same order run by key, not by registration order', async () => {
    const ref = await boot([
      { module: class Z {}, providers: [Zeta] },
      { module: class Al {}, providers: [Alpha] },
      ModP1,
      ModP2,
    ]);
    expect(
      ref
        .get(OrgPurgeParticipantRegistry)
        .participants()
        .map((p) => [p.key, p.order]),
    ).toEqual([
      ['first', 0],
      ['alpha', 3],
      ['zeta', 3],
      ['second', 10],
    ]);
    await ref.close();
  });
  it('duplicate participant keys and non-participants refuse to boot', async () => {
    await expect(
      boot([ModP2, { module: class Dup {}, providers: [FirstAgain] }]),
    ).rejects.toThrow(/Duplicate org purge participant "first"/);
    await expect(
      boot([{ module: class Bad {}, providers: [NotAParticipant] }]),
    ).rejects.toThrow(
      /must be a singleton provider extending OrgPurgeParticipant/,
    );
  });
  it('R-X5: order 1000 is reserved for tenancy core (always last) and orders below 0 are refused', async () => {
    await expect(
      boot([{ module: class Core {}, providers: [TakesCoreSlot] }]),
    ).rejects.toThrow(/order: integer in \[0, 1000\)/);
    await expect(
      boot([{ module: class Neg {}, providers: [NegativeOrder] }]),
    ).rejects.toThrow(/order: integer in \[0, 1000\)/);
  });
  it('purge order: 3D tables first (bridge before parent), then 3C, then members (spec §9.5)', () => {
    const tables = ORG_PURGE_STATEMENTS.map(
      (s) => /DELETE FROM (\w+)/.exec(s)?.[1],
    );
    expect(tables.slice(0, 5)).toEqual([
      'org_support_grant_permissions',
      'org_support_grants',
      'org_api_key_permissions',
      'org_api_keys',
      'org_ownership_transfers',
    ]);
    expect(tables.indexOf('org_api_keys')).toBeLessThan(
      tables.indexOf('org_members'),
    );
  });
});
