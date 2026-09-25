import { Injectable } from '@nestjs/common';
import { InjectEntityManager } from '@mikro-orm/nestjs';
import { EntityManager, type ForkOptions } from '@mikro-orm/postgresql';
import { ClsService } from 'nestjs-cls';
import { CTX } from '../context/index.js';
import { DB_CONTEXT } from './constants.js';

/**
 * EntityManager gắn với ngữ cảnh hiện tại (CLS key CTX.em). Không dùng EM toàn cục
 * (`allowGlobalContext: false`) và không dựa vào context của MikroORM: mọi fork đi
 * từ EM gốc của connection `app` với `disableContextResolution`.
 * Chỉ dùng trong `core/database` và `infra/`.
 */
@Injectable()
export class TxEm {
  constructor(
    @InjectEntityManager(DB_CONTEXT.app) private readonly root: EntityManager,
    private readonly cls: ClsService,
  ) {}

  current(): EntityManager | undefined {
    if (!this.cls.isActive()) return undefined;
    const em: unknown = this.cls.get(CTX.em);
    if (em === undefined) return undefined;
    if (!(em instanceof EntityManager))
      throw new Error(
        `Context key ${CTX.em} holds a value that is not a PostgreSQL EntityManager`,
      );
    return em;
  }

  get(): EntityManager {
    const em = this.current();
    if (!em)
      throw new Error(
        'No EntityManager in context: call inside UnitOfWork.run or OrgScope.run',
      );
    return em;
  }

  fork(opts: ForkOptions = {}): EntityManager {
    return this.root.fork({ disableContextResolution: true, ...opts });
  }

  /** Chạy fn trong một CLS context con có CTX.em = em; context cha không bị đổi. */
  bind<T>(em: EntityManager, fn: () => Promise<T>): Promise<T> {
    const run = (): Promise<T> => {
      this.cls.set(CTX.em, em);
      return fn();
    };
    return this.cls.isActive()
      ? this.cls.run({ ifNested: 'inherit' }, run)
      : this.cls.run(run);
  }
}
