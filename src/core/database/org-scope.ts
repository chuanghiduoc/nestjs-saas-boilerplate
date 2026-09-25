import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { RequestContext } from '../context/index.js';
import { AppError, CoreErrors } from '../errors/index.js';
import { ORG_SESSION_VAR } from './constants.js';
import { TxEm } from './tx-em.js';

const OrgId = z.uuid();

/**
 * Chạy fn trong ngữ cảnh một org: fork EM mang session `app.org_id` (MikroORM áp
 * `set_config(..., true)` ngay sau BEGIN của mỗi transaction, kể cả transaction ngầm
 * của một câu lệnh lẻ), gắn fork vào CLS và đặt `RequestContext.orgId`.
 *
 * Trong transaction đang mở không thể đổi session nữa, nên chỉ cho chạy tiếp khi
 * transaction đó mang đúng org này (đọc từ session của chính EM đang gắn, là giá trị
 * Postgres thực sự thấy); khác org hoặc không có org thì ném lỗi.
 */
@Injectable()
export class OrgScope {
  constructor(
    private readonly txEm: TxEm,
    private readonly ctx: RequestContext,
  ) {}

  run<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
    if (!OrgId.safeParse(orgId).success) {
      return Promise.reject(
        new AppError(CoreErrors.ORG_CONTEXT_INVALID, {
          detail: 'orgId must be a UUID',
        }),
      );
    }
    const current = this.txEm.current();
    if (current?.isInTransaction()) {
      const active = current.getSessionContext()?.variables?.[ORG_SESSION_VAR];
      if (active === orgId) return fn();
      return Promise.reject(
        new Error(
          'OrgScope.run cannot switch to a different organization inside an open transaction',
        ),
      );
    }
    const forked = this.txEm.fork({
      session: { variables: { [ORG_SESSION_VAR]: orgId } },
    });
    return this.txEm.bind(forked, () => {
      this.ctx.setOrgId(orgId);
      return fn();
    });
  }
}
