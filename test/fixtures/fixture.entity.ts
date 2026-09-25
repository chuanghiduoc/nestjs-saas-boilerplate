import { defineEntity, p } from '@mikro-orm/core';
import { registerEntities } from '../../src/core/database/index.js';

export const FixtureNote = defineEntity({
  name: 'FixtureNote',
  tableName: 'fixture_notes',
  properties: {
    id: p.bigint().primary(),
    body: p.text(),
    createdAt: p
      .datetime()
      .fieldName('created_at')
      .onCreate(() => new Date()),
    updatedAt: p
      .datetime()
      .fieldName('updated_at')
      .onCreate(() => new Date())
      .onUpdate(() => new Date()),
  },
});
registerEntities(FixtureNote);
