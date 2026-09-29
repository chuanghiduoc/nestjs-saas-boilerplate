import type { EventActor } from '../../../core/events/index.js';

/**
 * Bên tham gia tạo org (spec SP4 §22.2 T1, S4-D9): chạy TRONG transaction tạo org, trong `OrgScope(newId)`, SAU khi dòng
 * `organizations` + 3 role hệ thống đã chèn và TRƯỚC `MemberAdmission` của người tạo. Chỉ ghi DB của mình (không I/O
 * ngoài, event đi outbox cùng transaction); ném → không có org. `actor` là actor của thao tác tạo org.
 */
export abstract class OrgCreationParticipant {
  abstract onOrgCreated(orgId: string, actor: EventActor): Promise<void>;
}
export type OrgCreationParticipantMeta = { key: string; order: number };
