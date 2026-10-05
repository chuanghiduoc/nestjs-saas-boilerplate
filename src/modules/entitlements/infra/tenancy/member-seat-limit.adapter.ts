import { Injectable } from '@nestjs/common';
import { MemberSeatLimit, type SeatLimit } from '../../../tenancy/index.js';
import { Entitlements } from '../../application/entitlements.service.js';
import { BoilerplateFeatures } from '../../features.js';

const SEATS = BoilerplateFeatures.key('tenancy.seats');

/**
 * Port ghế của tenancy (spec SP4 §9.6): trần hiệu lực `OVERRIDE > PLAN > FALLBACK` của `tenancy.seats` tại snapshot của
 * câu đọc, trong transaction của `MemberAdmission` (thấy gói vừa ghi cùng transaction). Một câu snapshot, không khoá, không
 * ghi: khoá org đã do tenancy giữ (đầu thứ tự khoá §3.6). Thiếu dòng / gói lạ → lỗi có tên (503), không bao giờ "không
 * giới hạn" (fail closed).
 */
@Injectable()
export class MemberSeatLimitAdapter extends MemberSeatLimit {
  constructor(private readonly entitlements: Entitlements) {
    super();
  }

  async current(): Promise<SeatLimit> {
    const limit = await this.entitlements.limitOf(SEATS);
    switch (limit.kind) {
      case 'UNLIMITED':
        return { kind: 'UNLIMITED' };
      case 'MAX':
        return { kind: 'MAX', max: limit.max, featureKey: SEATS };
      default: {
        const unknown: never = limit;
        throw new Error(`unknown limit ${JSON.stringify(unknown)}`);
      }
    }
  }
}
