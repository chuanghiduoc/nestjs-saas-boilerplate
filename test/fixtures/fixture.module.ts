import { Injectable, Module } from '@nestjs/common';
import { Db } from '../../src/core/database/index.js';
import './fixture.entity.js';

@Injectable()
export class FixtureRepo {
  constructor(private readonly db: Db) {}
  async insertSystemNote(body: string): Promise<void> {
    await this.db.execute('INSERT INTO fixture_notes (body) VALUES (?)', [
      body,
    ]);
  }
  async countSystemNotes(body: string): Promise<number> {
    const rows = await this.db.execute<{ n: string }>(
      'SELECT count(*)::text AS n FROM fixture_notes WHERE body = ?',
      [body],
    );
    return Number(rows[0]!.n);
  }
}

@Module({ providers: [FixtureRepo], exports: [FixtureRepo] })
export class FixtureModule {}
