import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
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

/** Mọi khác biệt giữa catalogue gộp trong code và dòng DB, sắp theo key (spec SP3 §8.8). Rỗng = khớp. */
export function catalogueDiff(
  merged: MergedCatalogue,
  rows: readonly CatalogueRow[],
): string[] {
  const out: string[] = [];
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
      out.push(`${key}: in the database, missing in code`);
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
  return out;
}

/** Api và worker: catalogue lệch DB (thiếu migration, pod lệch version) → app không khởi động (fail loud). */
@Injectable()
export class CatalogueCheck implements OnApplicationBootstrap {
  private readonly logger = new Logger(CatalogueCheck.name);

  constructor(
    private readonly registry: PermissionCatalogueRegistry,
    private readonly reader: CatalogueReader,
    private readonly metrics: TenancyMetrics,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const differences = catalogueDiff(
      this.registry.merged(),
      await this.reader.readAll(),
    );
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
