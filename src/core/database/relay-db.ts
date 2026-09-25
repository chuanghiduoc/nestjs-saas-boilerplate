import { Injectable } from '@nestjs/common';
import { InjectEntityManager } from '@mikro-orm/nestjs';
import { EntityManager } from '@mikro-orm/postgresql';
import { DB_CONTEXT } from './constants.js';

export type SqlTx = {
  execute<T extends object = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]>;
};

/** Connection `relay` (role app_relay): chỉ có quyền trên bảng hạ tầng được GRANT trong migration. Chỉ có trong worker. */
@Injectable()
export class RelayDb {
  constructor(
    @InjectEntityManager(DB_CONTEXT.relay) private readonly root: EntityManager,
  ) {}

  execute<T extends object = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    return this.fork().execute<T[]>(sql, params);
  }

  transaction<R>(fn: (tx: SqlTx) => Promise<R>): Promise<R> {
    return this.fork().transactional((em) =>
      fn({
        execute: <T extends object = Record<string, unknown>>(
          sql: string,
          params: unknown[] = [],
        ) => em.execute<T[]>(sql, params),
      }),
    );
  }

  private fork(): EntityManager {
    return this.root.fork({ disableContextResolution: true });
  }
}
