import { Inject, Injectable } from '@nestjs/common';
import type pg from 'pg';
import {
  ReadinessContributor,
  type ReadinessProbe,
} from '../../../../core/health/index.js';
import { AUTH_POOL } from './auth-pool.provider.js';

/** Pool auth chết thì mọi request cần xác thực đều hỏng (spec §5.13). Không có ở `external`. */
@Injectable()
@ReadinessContributor('auth_database')
export class AuthDatabaseReadiness implements ReadinessProbe {
  constructor(@Inject(AUTH_POOL) private readonly pool: pg.Pool) {}
  async probe(): Promise<void> {
    await this.pool.query('SELECT 1');
  }
}
