import { z } from 'zod';
import {
  MaintenanceQueue,
  defineJob,
  findJob,
  type JobDef,
} from '../queue/index.js';
import { cronRegistry, defineCron } from '../scheduler/cron-definition.js';
import { DEFINER_LIMIT_MAX } from './constants.js';

export class OrgSweepDefinitionError extends Error {
  constructor(key: string, detail: string) {
    super(`Org sweep "${key}": ${detail}`);
    this.name = 'OrgSweepDefinitionError';
  }
}

export type OrgSweepParamValue = number | boolean | string;
/** Tham số thêm của hàm SQL, THEO TÊN (`p_…`), đọc mỗi lượt (R-X14). Khoảng thời gian truyền bằng số nguyên giây. */
export type OrgSweepParams = Readonly<Record<string, OrgSweepParamValue>>;
export type OrgSweepBatch = { size: number; maxBatches: number };
export type OrgSweepDef = {
  readonly key: string;
  /** Tên hàm SQL trong schema `public`, chữ ký cố định `(p_after uuid, p_limit integer, <tham số thêm>)`, `RETURNS TABLE (org_id uuid)`. */
  readonly definerFunction: string;
  readonly extraParams: () => OrgSweepParams;
  /** Job theo org (queue của module, payload `{}`, org ở `meta.orgId`); phải idempotent. */
  readonly orgJob: JobDef;
  readonly jobIdPrefix: string;
  readonly schedule: () => { cron: string; tz: string };
  readonly batch: () => OrgSweepBatch;
  /** Job quét: tên = `key`, queue `maintenance`, payload `{}`; module khai handler mỏng gọi `OrgSweepRunner.run`. */
  readonly job: JobDef;
};

/**
 * `key` vừa là tên job quét (`defineJob`: `^[a-z][a-z0-9._-]*$`) vừa là key cron (`defineCron`: `^[a-z0-9][a-z0-9._-]{0,99}$`,
 * id scheduler `static-<key>`): giao của hai luật. Kiểm ở đây để lỗi là `OrgSweepDefinitionError`, không phải `Error` trần
 * của hai registry kia.
 */
const SWEEP_KEY = /^[a-z][a-z0-9._-]{0,99}$/;
const FUNCTION_NAME = /^[a-z][a-z0-9_]*$/;
const JOB_ID_PREFIX = /^[a-z][a-z0-9-]*$/;
const PARAM_NAME = /^p_[a-z][a-z0-9_]*$/;
const RESERVED = new Set(['p_after', 'p_limit']);
const INT4_MIN = -2_147_483_648;
const INT4_MAX = 2_147_483_647;
const sweeps = new Map<string, OrgSweepDef>();

/**
 * Một cơ chế quét xuyên org cho mọi SP (R-X4, R-X14; spec SP6 §5.3): cron → hàm SQL `SECURITY DEFINER` của `sweep_definer`
 * trả org đến hạn theo keyset → một job theo org. Registry lúc import; tự `defineJob` job quét và `defineCron`.
 * Không nhận callback TS: runner là nơi duy nhất gọi hàm definer, luôn qua `EXECUTE` của `app_user`.
 */
export function defineOrgSweep(input: {
  key: string;
  definerFunction: string;
  extraParams?: () => OrgSweepParams;
  orgJob: JobDef;
  jobIdPrefix: string;
  schedule: () => { cron: string; tz: string };
  batch: () => OrgSweepBatch;
}): OrgSweepDef {
  const fail = (detail: string): never => {
    throw new OrgSweepDefinitionError(input.key, detail);
  };
  if (!SWEEP_KEY.test(input.key))
    fail(`key must match ${SWEEP_KEY} (it names the sweep job and its cron)`);
  if (!FUNCTION_NAME.test(input.definerFunction))
    fail(
      `definerFunction "${input.definerFunction}" must match ${FUNCTION_NAME} (a function of schema public)`,
    );
  if (!JOB_ID_PREFIX.test(input.jobIdPrefix))
    fail(`jobIdPrefix "${input.jobIdPrefix}" must match ${JOB_ID_PREFIX}`);
  if (!input.orgJob.schema.safeParse({}).success)
    fail(
      `orgJob "${input.orgJob.name}" must accept the payload {} (the org travels in meta.orgId)`,
    );
  if (sweeps.has(input.key)) fail('already defined');
  // Mọi kiểm trước khi đăng ký bất cứ gì: `defineCron` ném sau khi `defineJob` đã thành công sẽ để lại job quét không có sweep.
  if (findJob(input.key)) fail(`a job named "${input.key}" is already defined`);
  if (cronRegistry().some((c) => c.key === input.key))
    fail(`a cron with key "${input.key}" is already defined`);
  const job = defineJob({
    name: input.key,
    queue: MaintenanceQueue,
    version: 1,
    schema: z.object({}),
  });
  defineCron({ key: input.key, job, payload: {}, schedule: input.schedule });
  const def: OrgSweepDef = {
    key: input.key,
    definerFunction: input.definerFunction,
    extraParams: input.extraParams ?? (() => ({})),
    orgJob: input.orgJob,
    jobIdPrefix: input.jobIdPrefix,
    schedule: input.schedule,
    batch: input.batch,
    job,
  };
  sweeps.set(input.key, def);
  return def;
}

export const orgSweepRegistry = (): OrgSweepDef[] => [...sweeps.values()];
export const findOrgSweep = (key: string): OrgSweepDef | undefined =>
  sweeps.get(key);
/** Chống trùng duy nhất (spec §5.3): theo slot, không `:` (BullMQ). */
export const sweepJobId = (
  def: OrgSweepDef,
  orgId: string,
  slot: number,
): string => `${def.jobIdPrefix}-${orgId}-${slot}`;

/** Kích thước lô mỗi lượt (thunk đọc config): `size` trong `[1, DEFINER_LIMIT_MAX]`, `maxBatches` ≥ 1. */
export function checkedBatch(def: OrgSweepDef): OrgSweepBatch {
  const b = def.batch();
  if (!Number.isSafeInteger(b.size) || b.size < 1 || b.size > DEFINER_LIMIT_MAX)
    throw new OrgSweepDefinitionError(
      def.key,
      `batch size must be an integer in [1, ${DEFINER_LIMIT_MAX}], got ${b.size}`,
    );
  if (!Number.isSafeInteger(b.maxBatches) || b.maxBatches < 1)
    throw new OrgSweepDefinitionError(
      def.key,
      `maxBatches must be a positive integer, got ${b.maxBatches}`,
    );
  return b;
}

/** Tham số thêm đã kiểm (Review Focus 3): tên `p_…` khác `p_after`/`p_limit`; số là int4; chỉ number/boolean/string. */
export function checkedParams(
  def: OrgSweepDef,
): [string, OrgSweepParamValue][] {
  const entries = Object.entries(def.extraParams());
  for (const [name, value] of entries) {
    if (!PARAM_NAME.test(name) || RESERVED.has(name))
      throw new OrgSweepDefinitionError(
        def.key,
        `extra parameter name "${name}" must match ${PARAM_NAME} and not be p_after or p_limit`,
      );
    const ok =
      typeof value === 'boolean' ||
      typeof value === 'string' ||
      (typeof value === 'number' &&
        Number.isSafeInteger(value) &&
        value >= INT4_MIN &&
        value <= INT4_MAX);
    if (!ok)
      throw new OrgSweepDefinitionError(
        def.key,
        `extra parameter ${name} must be a 32-bit integer, a boolean or a string, got ${String(value)}`,
      );
  }
  return entries;
}

const castOf = (v: OrgSweepParamValue): string =>
  typeof v === 'number'
    ? 'integer'
    : typeof v === 'boolean'
      ? 'boolean'
      : 'text';

/**
 * Câu của runner: ký hiệu tham số theo tên của Postgres, ép kiểu tường minh theo kiểu JS (không dựa vào ép kiểu ngầm của
 * literal không kiểu). Tên hàm và tên tham số đã qua regex nên nối vào SQL an toàn; giá trị đi qua placeholder.
 */
export function sweepSql(
  def: OrgSweepDef,
  params: [string, OrgSweepParamValue][],
): string {
  const extras = params
    .map(([name, value]) => `, ${name} => ?::${castOf(value)}`)
    .join('');
  return `SELECT org_id::text AS org_id FROM public.${def.definerFunction}(p_after => ?::uuid, p_limit => ?::integer${extras})`;
}
