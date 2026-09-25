import { Injectable } from '@nestjs/common';
import { TxEm } from './tx-em.js';

/**
 * SQL trên connection `app`. Trong UnitOfWork/OrgScope thì dùng đúng transaction và
 * session RLS hiện tại; ngoài đó thì fork mới (không có org → bảng tenant fail-closed).
 * Tham số dùng placeholder `?` (MikroORM tự escape theo platform).
 */
@Injectable()
export class Db {
  constructor(private readonly txEm: TxEm) {}

  execute<T extends object = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    return (this.txEm.current() ?? this.txEm.fork()).execute<T[]>(sql, params);
  }
}
