import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { RequestContext } from '../context/index.js';
import { AppError, CoreErrors } from '../errors/index.js';
import { ORG_SESSION_VAR } from './constants.js';
import { TxEm } from './tx-em.js';

/**
 * Chuẩn hoá về chữ thường ở biên: cùng một org có thể đến ở dạng hoa (header) hoặc thường
 * (Postgres trả uuid chữ thường), và mọi phép so sánh/session/RequestContext dùng dạng này.
 */
const OrgId = z.uuid().transform((s) => s.toLowerCase());

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

  run<T>(rawOrgId: string, fn: () => Promise<T>): Promise<T> {
    const parsed = OrgId.safeParse(rawOrgId);
    if (!parsed.success) {
      return Promise.reject(
        new AppError(CoreErrors.ORG_CONTEXT_INVALID, {
          detail: 'orgId must be a UUID',
        }),
      );
    }
    const orgId = parsed.data;
    const current = this.txEm.current();
    if (current?.isInTransaction()) {
      const active = current.getSessionContext()?.variables?.[ORG_SESSION_VAR];
      if (active === orgId) return fn();
      return Promise.reject(
        new Error(
          active === undefined
            ? 'OrgScope.run cannot enter an org inside a transaction opened without org context; call OrgScope.run outside UnitOfWork.run'
            : 'OrgScope.run cannot switch to a different organization inside an open transaction',
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
