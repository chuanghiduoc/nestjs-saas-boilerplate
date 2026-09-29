import { Inject, Injectable } from '@nestjs/common';
import type { ConfigOf } from '../../../core/config/index.js';
import type { Principal } from '../../../core/context/index.js';
import { identityConfig } from '../../identity/index.js';
import type { TenancySubject } from '../ports/tenancy-user-repository.js';

/** Spec SP3 §6.2, §11: `local`/`hybrid` → `auth."user".id`; `external` → `sub`. Đổi mode trên dữ liệu có sẵn: runbook. */
@Injectable()
export class SubjectResolver {
  constructor(
    @Inject(identityConfig.KEY)
    private readonly identity: ConfigOf<typeof identityConfig>,
  ) {}

  of(p: Principal): TenancySubject {
    if (p.type !== 'user')
      throw new Error(
        `tenancy subjects are users; got principal type ${p.type}`,
      );
    return this.identity.mode === 'external'
      ? { kind: 'EXTERNAL', externalSubject: p.id }
      : { kind: 'AUTH_USER', authUserId: p.id };
  }
}
