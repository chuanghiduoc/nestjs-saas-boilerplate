import { Injectable, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import {
  OrgCreationParticipantContributor,
  OrgCreationParticipantRegistry,
} from '../../../../src/modules/tenancy/application/org-creation-participant.registry.js';
import { OrgCreationParticipant } from '../../../../src/modules/tenancy/ports/org-creation-participant.js';

class Noop extends OrgCreationParticipant {
  onOrgCreated(): Promise<void> {
    return Promise.resolve();
  }
}
@Injectable()
@OrgCreationParticipantContributor({ key: 'second', order: 10 })
class Second extends Noop {}
@Injectable()
@OrgCreationParticipantContributor({ key: 'first', order: 0 })
class First extends Noop {}
@Injectable()
@OrgCreationParticipantContributor({ key: 'first', order: 5 })
class FirstAgain extends Noop {}
@Injectable()
@OrgCreationParticipantContributor({ key: 'other', order: 0 })
class SameOrder extends Noop {}
@Injectable()
@OrgCreationParticipantContributor({ key: 'Bad Key', order: 1 })
class BadKey extends Noop {}
@Injectable()
@OrgCreationParticipantContributor({ key: 'half', order: 1.5 })
class HalfOrder extends Noop {}
@Injectable()
@OrgCreationParticipantContributor({ key: 'broken', order: 1 })
class NotAParticipant {}
@Module({ providers: [Second] })
class ModA {}
@Module({ providers: [First] })
class ModB {}

const boot = async (
  imports: NonNullable<
    Parameters<typeof Test.createTestingModule>[0]['imports']
  >,
) => {
  const ref = await Test.createTestingModule({
    imports: [DiscoveryModule, ...imports],
    providers: [OrgCreationParticipantRegistry],
  }).compile();
  await ref.init();
  return ref;
};

describe('OrgCreationParticipantRegistry (spec SP4 §22.2 T1)', () => {
  it('collects participants from two modules and orders them by order then key', async () => {
    const ref = await boot([ModA, ModB]);
    expect(
      ref
        .get(OrgCreationParticipantRegistry)
        .participants()
        .map((p) => [p.key, p.order]),
    ).toEqual([
      ['first', 0],
      ['second', 10],
    ]);
    await ref.close();
  });
  it('refuses a duplicate key, a duplicate order, a malformed key, a non-integer order and a non-participant', async () => {
    await expect(
      boot([ModB, { module: class Dup {}, providers: [FirstAgain] }]),
    ).rejects.toThrow(/Duplicate org creation participant key "first"/);
    await expect(
      boot([ModB, { module: class Same {}, providers: [SameOrder] }]),
    ).rejects.toThrow(/Duplicate org creation participant order 0/);
    await expect(
      boot([{ module: class K {}, providers: [BadKey] }]),
    ).rejects.toThrow(/needs \{ key: /);
    await expect(
      boot([{ module: class H {}, providers: [HalfOrder] }]),
    ).rejects.toThrow(/needs \{ key: /);
    await expect(
      boot([{ module: class N {}, providers: [NotAParticipant] }]),
    ).rejects.toThrow(
      /must be a singleton provider extending OrgCreationParticipant/,
    );
  });
});
