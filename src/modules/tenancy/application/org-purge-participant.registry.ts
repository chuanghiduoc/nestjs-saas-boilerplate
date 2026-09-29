import { Injectable, type OnModuleInit } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
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
        !Number.isInteger(meta.order)
      )
        throw new Error(
          `@OrgPurgeParticipantContributor on ${wrapper.name} needs { key: ${PARTICIPANT_KEY_PATTERN}, order: integer }`,
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
      found.push({
        key: meta.key,
        order: meta.order,
        participant: wrapper.instance,
      });
    }
    this.registered = found.sort(
      (a, b) => a.order - b.order || a.key.localeCompare(b.key),
    );
  }

  participants(): readonly RegisteredParticipant[] {
    return this.registered;
  }
}
