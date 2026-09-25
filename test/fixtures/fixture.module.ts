import { Injectable, Module } from '@nestjs/common';
import {
  Db,
  TxEm,
  countUpTo,
  escapeLike,
  withClientCursor,
} from '../../src/core/database/index.js';
import { FixtureNote } from './fixture.entity.js';

/** Thứ tự ổn định: trường sort rồi khoá duy nhất làm tiebreaker. */
const NOTES_ORDER = { body: 'asc', id: 'asc' } as const;

/** Allowlist sort của API → cột SQL. Mỗi cột phải có index (spec §3). */
export const NOTE_SORTABLE = ['body', 'createdAt'] as const;
const NOTE_SORT_COLUMNS: Record<(typeof NOTE_SORTABLE)[number], string> = {
  body: 'body',
  createdAt: 'created_at',
};
const SQL_DIRECTION = { asc: 'ASC', desc: 'DESC' } as const;

@Injectable()
export class FixtureRepo {
  constructor(
    private readonly db: Db,
    private readonly txEm: TxEm,
  ) {}

  /** Mẫu chuẩn cho repo có danh sách cursor: repo trả dữ liệu thô, controller bọc `Paginator`. */
  async listPage(
    prefix: string,
    q: { limit: number; cursor?: string },
  ): Promise<{
    items: { body: string }[];
    hasMore: boolean;
    nextCursor: string | null;
  }> {
    const res = await withClientCursor(q.cursor, NOTES_ORDER, () =>
      (this.txEm.current() ?? this.txEm.fork()).findByCursor(FixtureNote, {
        where: { body: { $like: `${escapeLike(prefix)}%` } },
        first: q.limit,
        after: q.cursor,
        orderBy: NOTES_ORDER,
        includeCount: false,
      }),
    );
    return {
      items: res.items.map((n) => ({ body: n.body })),
      hasMore: res.hasNextPage,
      nextCursor: res.hasNextPage ? res.endCursor : null,
    };
  }
  /**
   * Mẫu chuẩn cho repo có danh sách offset: sort đã qua allowlist (`offsetPageQuery`) được map sang
   * cột bằng bảng tĩnh, tiebreaker `id`, đếm có trần bằng `countUpTo` trên cùng điều kiện lọc.
   */
  async listOffsetPage(
    prefix: string,
    q: {
      page: number;
      pageSize: number;
      sort?: {
        field: (typeof NOTE_SORTABLE)[number];
        direction: 'asc' | 'desc';
      };
    },
    countCap: number,
  ): Promise<{ items: { body: string }[]; counted: number }> {
    const from = 'FROM fixture_notes WHERE body LIKE ?';
    const params = [`${escapeLike(prefix)}%`];
    const sort = q.sort ?? { field: 'body', direction: 'asc' };
    const dir = SQL_DIRECTION[sort.direction];
    const items = await this.db.execute<{ body: string }>(
      `SELECT body ${from} ORDER BY ${NOTE_SORT_COLUMNS[sort.field]} ${dir}, id ${dir} LIMIT ? OFFSET ?`,
      [...params, q.pageSize, (q.page - 1) * q.pageSize],
    );
    const counted = await countUpTo(
      this.db,
      `SELECT 1 ${from}`,
      params,
      countCap,
    );
    return { items, counted };
  }
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
