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
  async insertOrgNote(orgId: string, body: string): Promise<void> {
    await this.db.execute(
      'INSERT INTO fixture_org_notes (org_id, body) VALUES (?, ?)',
      [orgId, body],
    );
  }
  async listOrgBodies(): Promise<string[]> {
    return (
      await this.db.execute<{ body: string }>(
        'SELECT body FROM fixture_org_notes ORDER BY id',
      )
    ).map((r) => r.body);
  }
  async insertParent(): Promise<string> {
    return (
      await this.db.execute<{ id: string }>(
        'INSERT INTO fixture_parents DEFAULT VALUES RETURNING id::text AS id',
      )
    )[0]!.id;
  }
  async insertChild(
    parentId: string,
    email: string,
    qty: number,
  ): Promise<void> {
    await this.db.execute(
      'INSERT INTO fixture_children (parent_id, email, qty) VALUES (?::bigint, ?, ?)',
      [parentId, email, qty],
    );
  }
  async deleteParent(id: string): Promise<void> {
    await this.db.execute('DELETE FROM fixture_parents WHERE id = ?::bigint', [
      id,
    ]);
  }
  async readCounter(id: string): Promise<number> {
    return (
      await this.db.execute<{ counter: number }>(
        'SELECT counter FROM fixture_parents WHERE id = ?::bigint',
        [id],
      )
    )[0]!.counter;
  }
  async writeCounter(id: string, value: number): Promise<void> {
    await this.db.execute(
      'UPDATE fixture_parents SET counter = ?, updated_at = now() WHERE id = ?::bigint',
      [value, id],
    );
  }
  async readNoGrant(): Promise<void> {
    await this.db.execute('SELECT 1 FROM fixture_no_grant');
  }
  async sleepSeconds(s: number): Promise<void> {
    await this.db.execute('SELECT pg_sleep(?)', [s]);
  }
}

@Module({ providers: [FixtureRepo], exports: [FixtureRepo] })
export class FixtureModule {}
