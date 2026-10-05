import { Injectable, type OnModuleInit } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { TENANCY_CORE_PURGE_ORDER } from '../constants.js';
import {
  OrgPurgeParticipant,
  type OrgPurgeParticipantMeta,
} from '../ports/org-purge-participant.js';

export const OrgPurgeParticipantContributor =
  DiscoveryService.createDecorator<OrgPurgeParticipantMeta>();
export type RegisteredParticipant = {
  key: string;
  order: number;
  participant: OrgPurgeParticipant;
};
const PARTICIPANT_KEY_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;

@Injectable()
export class OrgPurgeParticipantRegistry implements OnModuleInit {
  private registered: readonly RegisteredParticipant[] = [];

  constructor(private readonly discovery: DiscoveryService) {}

  onModuleInit(): void {
    const found: RegisteredParticipant[] = [];
    for (const wrapper of this.discovery.getProviders({
      metadataKey: OrgPurgeParticipantContributor.KEY,
    })) {
      const meta = this.discovery.getMetadataByDecorator(
        OrgPurgeParticipantContributor,
        wrapper,
      );
      if (
        !meta ||
        !PARTICIPANT_KEY_PATTERN.test(meta.key) ||
        !Number.isInteger(meta.order) ||
        meta.order < 0 ||
        meta.order >= TENANCY_CORE_PURGE_ORDER
      )
        throw new Error(
          `@OrgPurgeParticipantContributor on ${wrapper.name} needs { key: ${PARTICIPANT_KEY_PATTERN}, order: integer in [0, ${TENANCY_CORE_PURGE_ORDER}) } (R-X5: ${TENANCY_CORE_PURGE_ORDER} is tenancy core, always last)`,
        );
      if (
        !wrapper.isDependencyTreeStatic() ||
        !(wrapper.instance instanceof OrgPurgeParticipant)
      )
        throw new Error(
          `Org purge participant "${meta.key}" must be a singleton provider extending OrgPurgeParticipant`,
        );
      if (found.some((p) => p.key === meta.key))
        throw new Error(`Duplicate org purge participant "${meta.key}"`);
      const sameOrder = found.find((p) => p.order === meta.order);
      if (sameOrder)
        throw new Error(
          `Duplicate org purge participant order ${meta.order} (${[
            sameOrder.key,
            meta.key,
          ]
            .sort()
            .map((k) => `"${k}"`)
            .join(
              ', ',
            )}): each participant needs its own order (spec SP3 §8.2, addendum 3D §A4)`,
        );
      found.push({
        key: meta.key,
        order: meta.order,
        participant: wrapper.instance,
      });
    }
    this.registered = found.sort((a, b) => a.order - b.order);
  }

  participants(): readonly RegisteredParticipant[] {
    return this.registered;
  }
}
