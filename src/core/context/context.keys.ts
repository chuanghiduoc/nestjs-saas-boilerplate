/**
 * Khoá CLS phẳng (dấu `:`), KHÔNG dùng dấu `.`: nestjs-cls coi `.` là đường dẫn lồng
 * (`set("core.em")` ghi vào `store.core.em`), còn `cls.run({ ifNested: "inherit" })` chỉ
 * copy nông store, nên object `core` bị dùng chung và giá trị set trong context con
 * rò ra context cha.
 */
export const CTX = {
  requestId: 'core:requestId',
  clientRequestId: 'core:clientRequestId',
  traceId: 'core:traceId',
  traceparent: 'core:traceparent',
  path: 'core:path',
  orgId: 'core:orgId',
  principal: 'core:principal',
  credential: 'core:credential',
  orgAccess: 'core:orgAccess',
  jobId: 'core:jobId',
  em: 'core:em',
} as const;

export type ContextValues = {
  requestId: string;
  traceId?: string;
  traceparent?: string;
  orgId?: string;
  jobId?: string;
};
