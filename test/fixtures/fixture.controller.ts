import { Body, Controller, Module, Post } from '@nestjs/common';
import { UnitOfWork } from '../../src/core/database/index.js';
import { EventPublisher } from '../../src/core/events/index.js';
import { FixtureModule, FixtureRepo } from './fixture.module.js';
import { NoteCreated } from './fixture.events.js';

@Controller('fixture/notes')
export class FixtureNotesController {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly repo: FixtureRepo,
    private readonly events: EventPublisher,
  ) {}

  @Post()
  async create(@Body() body: { body: string; fail?: boolean }) {
    await this.uow.run(async () => {
      await this.repo.insertSystemNote(body.body);
      await this.events.publish(NoteCreated, {
        data: { body: body.body },
        aggregate: { type: 'note', id: body.body, version: 1 },
        actor: { type: 'system', id: 'fixture' },
      });
      if (body.fail) throw new Error('fail after publish');
    });
    return { ok: true };
  }
}

/** Tách riêng khỏi FixtureModule vì cần EventsModule; test DB thuần không phải nạp events. */
@Module({ imports: [FixtureModule], controllers: [FixtureNotesController] })
export class FixtureNotesModule {}
