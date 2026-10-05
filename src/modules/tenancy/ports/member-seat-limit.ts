/** Trần số ghế hiện hành của org trong context hiện tại (spec SP4 §9.6). Ghế = một dòng `org_members`. */
export type SeatLimit =
  | { readonly kind: 'UNLIMITED' }
  | {
      readonly kind: 'MAX';
      readonly max: number;
      readonly featureKey: string;
    };

/**
 * Port (spec SP4 §9.6, amendment T5; cùng mẫu `@Global()` + `@Optional()` của SP3 §5.2): entitlements cài bằng module
 * `@Global()` ở api và worker; tenancy KHÔNG import entitlements (luật 20.8-a). Vắng → không giới hạn (hành vi SP3).
 * Gọi trong UnitOfWork + OrgScope của `MemberAdmission`, sau khoá org; adapter chỉ đọc (không khoá, không ghi). Đọc lỗi →
 * ném (fail closed: 503), không bao giờ trả "không giới hạn".
 */
export abstract class MemberSeatLimit {
  abstract current(): Promise<SeatLimit>;
}
