/**
 * Inventory của feature mẫu (spec SP7 S7-D28): test của boilerplate (`normalization-inventory`, `rls-catalog`,
 * `migration-scan`) gộp khai báo này qua `FEATURE_INVENTORIES`. `definerFunctions`/`definerReadTables` là của `sweep_definer`.
 */
export const tables = [
  {
    table: 'public.example_projects',
    columns: [
      'id',
      'public_id',
      'org_id',
      'name',
      'description',
      'status',
      'status_changed_at',
      'version',
      'created_at',
      'updated_at',
    ],
  },
];
export const definerFunctions = ['example_orgs_with_purgeable_projects'];
export const definerReadTables = ['example_projects'];
