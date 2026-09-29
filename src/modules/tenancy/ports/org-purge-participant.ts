/**
 * Bên tham gia xoá cứng org (spec SP3 §9.5): chạy TRONG transaction purge (OrgScope của org), chỉ xoá dòng DB của mình.
 * Dọn ngoài DB thuộc job do subscriber của `tenancy.org.purged` enqueue (`onInactiveOrg: 'run'`).
 */
export abstract class OrgPurgeParticipant {
  abstract purge(orgId: string): Promise<void>;
}
export type OrgPurgeParticipantMeta = { key: string; order: number };
