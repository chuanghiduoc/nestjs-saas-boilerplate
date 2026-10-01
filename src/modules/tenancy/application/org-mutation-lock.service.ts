import { Injectable } from '@nestjs/common';
import { RequestContext } from '../../../core/context/index.js';
import { UnitOfWork } from '../../../core/database/index.js';
import { OrgMutationLock } from '../ports/org-mutation-lock.js';
import { OrgRepository } from '../ports/org-repository.js';

@Injectable()
export class TenancyOrgMutationLock extends OrgMutationLock {
  constructor(
    private readonly orgs: OrgRepository,
    private readonly uow: UnitOfWork,
    private readonly ctx: RequestContext,
  ) {
    super();
  }

  async lock(): Promise<boolean> {
    // Khoá dòng ngoài transaction được nhả ngay sau câu lệnh: "đếm rồi thêm" sau đó sẽ là check-then-insert trần.
    if (!this.uow.inTransaction())
      throw new Error('OrgMutationLock.lock() must run inside UnitOfWork.run');
    if (this.ctx.orgId() === undefined)
      throw new Error('OrgMutationLock.lock() must run inside OrgScope');
    return (await this.orgs.lockCurrent()) !== undefined;
  }
}
