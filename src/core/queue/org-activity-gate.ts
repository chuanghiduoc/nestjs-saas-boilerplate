export const ON_INACTIVE_ORG = ['skip', 'run'] as const;
export type OnInactiveOrg = (typeof ON_INACTIVE_ORG)[number];
/**
 * Trạng thái org của job lúc bắt đầu (spec SP3 §5.2, R4A-N4): trả LÝ DO (không `boolean`) để job khai sai không
 * im lặng — `WorkerHost` log WARN khi org đã mất hoặc job được enqueue sau khi org bị xoá mềm.
 */
export type OrgActivity =
  { kind: 'ACTIVE' } | { kind: 'DELETED'; deletedAt: Date } | { kind: 'GONE' };
/**
 * Port của core, module tenancy cài (`TenancyQueuePortsModule`, `@Global`, chỉ trong `forWorker()`). Được gọi BÊN
 * TRONG `OrgScope` của job; lỗi hạ tầng thì ném (BullMQ retry theo backoff), không bao giờ đoán là `ACTIVE`.
 */
export abstract class OrgActivityGate {
  abstract check(): Promise<OrgActivity>;
}
