import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { ConfigOf } from '../../../../core/config/index.js';
import { Db } from '../../../../core/database/index.js';
import { identityConfig } from '../../../identity/index.js';
import { SubjectResolver } from '../../application/subject-resolver.js';
import { TenancyUserIds } from '../../ports/tenancy-user-ids.js';

/** `tenancy_users_external_subject_ck` (migration tenancy_core): ngoài khoảng thì không dòng nào khớp được. */
const EXTERNAL_SUBJECT_MAX_LENGTH = 255;
const Uuid = z.uuid();
const Rows = z.array(z.object({ subject: z.string(), public_id: z.string() }));

@Injectable()
export class SqlTenancyUserIds extends TenancyUserIds {
  constructor(
    private readonly db: Db,
    private readonly subjects: SubjectResolver,
    @Inject(identityConfig.KEY)
    private readonly identity: ConfigOf<typeof identityConfig>,
  ) {
    super();
  }

  async publicIdsBySubjects(
    subjects: readonly string[],
  ): Promise<ReadonlyMap<string, string>> {
    const out = new Map<string, string>();
    if (subjects.length === 0) return out;
    const max = this.identity.directoryBatchMax;
    if (subjects.length > max)
      throw new Error(
        `TenancyUserIds.publicIdsBySubjects accepts at most ${max} subjects (AUTH_DIRECTORY_BATCH_MAX), got ${subjects.length}`,
      );
    // SubjectResolver là nguồn duy nhất của AUTH_MODE (một mode mỗi process). Subject sai dạng của cột không bao giờ tới
    // SQL: chuỗi không phải UUID gặp `::uuid` là 22P02.
    const authUsers: string[] = [];
    const externals: string[] = [];
    for (const s of subjects) {
      const { kind } = this.subjects.of({ type: 'user', id: s });
      switch (kind) {
        case 'AUTH_USER':
          if (Uuid.safeParse(s).success) authUsers.push(s);
          break;
        case 'EXTERNAL':
          if (s.length >= 1 && s.length <= EXTERNAL_SUBJECT_MAX_LENGTH)
            externals.push(s);
          break;
        default: {
          const unknown: never = kind;
          throw new Error(`unknown tenancy subject kind ${String(unknown)}`);
        }
      }
    }
    // Postgres so uuid không phân biệt hoa thường: tra bằng chữ thường, trả về theo chuỗi gốc của caller.
    const byAuthUser = await this.lookup('auth_user_id', 'uuid', [
      ...new Set(authUsers.map((s) => s.toLowerCase())),
    ]);
    for (const s of authUsers) {
      const publicId = byAuthUser.get(s.toLowerCase());
      if (publicId) out.set(s, publicId);
    }
    const byExternal = await this.lookup('external_subject', 'text', [
      ...new Set(externals),
    ]);
    for (const s of externals) {
      const publicId = byExternal.get(s);
      if (publicId) out.set(s, publicId);
    }
    return out;
  }

  /** Không khoá, không ghi: chạy trên EM đang gắn (trong worker là transaction của deliver). Mảng rỗng không tới SQL. */
  private async lookup(
    column: 'auth_user_id' | 'external_subject',
    type: 'uuid' | 'text',
    values: string[],
  ): Promise<Map<string, string>> {
    if (values.length === 0) return new Map();
    const rows = Rows.parse(
      await this.db.execute(
        `SELECT ${column}::text AS subject, public_id::text AS public_id FROM tenancy_users
          WHERE ${column} = ANY(ARRAY[?]::${type}[])`,
        [values],
      ),
    );
    return new Map(rows.map((r) => [r.subject, r.public_id]));
  }
}
