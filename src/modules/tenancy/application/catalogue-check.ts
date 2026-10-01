import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { MergedCatalogue } from '../domain/catalogue.js';
import {
  CatalogueReader,
  type CatalogueRow,
} from '../ports/catalogue-reader.js';
import { PermissionCatalogueRegistry } from './permission-catalogue.registry.js';
import { TenancyMetrics } from './tenancy-metrics.js';

const COMPARED = [
  'resource',
  'action',
  'ownerOnly',
  'apiKeyEligible',
  'supportEligible',
  'deprecated',
] as const;

export type CatalogueDiff = {
  /** Khác biệt làm app không khởi động: key trong code thiếu ở DB, hoặc cờ/`requires` lệch trên key có ở cả hai. */
  fatal: string[];
  /**
   * Key có ở DB mà không catalogue nào đã nạp khai báo (R-X21): trơ, vì route và kiểm role chỉ dùng catalogue đã
   * nạp; pod boot trên DB chứa dòng của plan khác không được crash-loop. Chỉ WARN.
   */
  orphans: string[];
};

/** Mọi khác biệt giữa catalogue gộp trong code và dòng DB, sắp theo key (spec SP3 §8.8). Cả hai rỗng = khớp. */
export function catalogueDiff(
  merged: MergedCatalogue,
  rows: readonly CatalogueRow[],
): CatalogueDiff {
  const out: string[] = [];
  const orphans: string[] = [];
  const db = new Map(rows.map((r) => [r.key, r]));
  const keys = [...new Set([...merged.keys(), ...db.keys()])].sort();
  for (const key of keys) {
    const code = merged.get(key);
    const row = db.get(key);
    if (!row) {
      out.push(`${key}: in code, missing in the database`);
      continue;
    }
    if (!code) {
      orphans.push(key);
      continue;
    }
    for (const f of COMPARED)
      if (code[f] !== row[f])
        out.push(`${key}: ${f} code=${String(code[f])} db=${String(row[f])}`);
    const codeRequires = [...code.requires].sort().join(',');
    const dbRequires = [...row.requires].sort().join(',');
    if (codeRequires !== dbRequires)
      out.push(`${key}: requires code=[${codeRequires}] db=[${dbRequires}]`);
  }
  return { fatal: out, orphans };
}

/**
 * Api và worker: catalogue lệch DB (thiếu migration, pod lệch version) → app không khởi động (fail loud); key chỉ
 * có ở DB (orphan) → WARN một lần + `tenancy_catalogue_orphan_keys`, vẫn khởi động (R-X21).
 * `onModuleInit`, không phải `onApplicationBootstrap`: Nest chạy xong mọi `onModuleInit` trước mọi
 * `onApplicationBootstrap`, còn `WorkerHost` và `OutboxRelay` (module global, quét trước) bắt đầu consume ở
 * `onApplicationBootstrap`; kiểm ở đó thì worker lệch đã xử lý job trước khi chết (cùng lỗi S2-R31).
 */
@Injectable()
export class CatalogueCheck implements OnModuleInit {
  private readonly logger = new Logger(CatalogueCheck.name);

  constructor(
    private readonly registry: PermissionCatalogueRegistry,
    private readonly reader: CatalogueReader,
    private readonly metrics: TenancyMetrics,
  ) {}

  async onModuleInit(): Promise<void> {
    const { fatal: differences, orphans } = catalogueDiff(
      this.registry.merged(),
      await this.reader.readAll(),
    );
    if (orphans.length > 0) {
      this.metrics.catalogueOrphanKeys.add(orphans.length, { source: 'boot' });
      this.logger.warn(
        { event: 'catalogue_orphan_keys', keys: orphans },
        'permission keys in the database are not declared by any loaded catalogue; they are inert',
      );
    }
    if (differences.length === 0) return;
    this.metrics.catalogueMismatch.add(1);
    this.logger.error(
      { event: 'catalogue_mismatch', differences },
      'permission catalogue in code does not match the database',
    );
    throw new Error(
      `Permission catalogue does not match the database: ${differences.join('; ')}`,
    );
  }
}
