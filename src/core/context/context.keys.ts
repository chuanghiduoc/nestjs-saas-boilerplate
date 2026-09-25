export const CTX = {
  requestId: 'core.requestId',
  clientRequestId: 'core.clientRequestId',
  traceId: 'core.traceId',
  traceparent: 'core.traceparent',
  path: 'core.path',
  orgId: 'core.orgId',
  principal: 'core.principal',
  jobId: 'core.jobId',
  em: 'core.em',
} as const;

export type ContextValues = {
  requestId: string;
  traceId?: string;
  traceparent?: string;
  orgId?: string;
  jobId?: string;
};
