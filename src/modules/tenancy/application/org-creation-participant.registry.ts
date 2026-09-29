import { Injectable, type OnModuleInit } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import {
  OrgCreationParticipant,
  type OrgCreationParticipantMeta,
} from '../ports/org-creation-participant.js';

export const OrgCreationParticipantContributor =
  DiscoveryService.createDecorator<OrgCreationParticipantMeta>();
export type RegisteredCreationParticipant = {
  key: string;
  order: number;
  participant: OrgCreationParticipant;
};
const PARTICIPANT_KEY_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;

/** Cùng mẫu `OrgPurgeParticipantRegistry` (3A Task 19), thêm luật `order` duy nhất: thứ tự chạy không được phụ thuộc tên. */
@Injectable()
export class OrgCreationParticipantRegistry implements OnModuleInit {
  private registered: readonly RegisteredCreationParticipant[] = [];

  constructor(private readonly discovery: DiscoveryService) {}

  onModuleInit(): void {
    const found: RegisteredCreationParticipant[] = [];
    for (const wrapper of this.discovery.getProviders({
      metadataKey: OrgCreationParticipantContributor.KEY,
    })) {
      const meta = this.discovery.getMetadataByDecorator(
        OrgCreationParticipantContributor,
        wrapper,
      );
      if (
        !meta ||
        !PARTICIPANT_KEY_PATTERN.test(meta.key) ||
        !Number.isInteger(meta.order)
      )
        throw new Error(
          `@OrgCreationParticipantContributor on ${wrapper.name} needs { key: ${PARTICIPANT_KEY_PATTERN}, order: integer }`,
        );
      if (
        !wrapper.isDependencyTreeStatic() ||
        !(wrapper.instance instanceof OrgCreationParticipant)
      )
        throw new Error(
          `Org creation participant "${meta.key}" must be a singleton provider extending OrgCreationParticipant`,
        );
      if (found.some((p) => p.key === meta.key))
        throw new Error(`Duplicate org creation participant key "${meta.key}"`);
      if (found.some((p) => p.order === meta.order))
        throw new Error(
          `Duplicate org creation participant order ${meta.order} ("${meta.key}")`,
        );
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

  participants(): readonly RegisteredCreationParticipant[] {
    return this.registered;
  }
}
