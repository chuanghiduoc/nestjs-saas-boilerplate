import { defineConfigRule } from './core/config/index.js';
import './modules/identity/index.js';
import './modules/notifications/index.js';

const SECONDS_PER_DAY = 86_400;

/**
 * N7 (final-fixes rereview + cleanup-batch correction): quy tắc CHÉO module — retention của notifications phải sống
 * lâu hơn TTL token dài nhất của identity — không thuộc về file config của bên nào, mà thuộc về nơi ứng dụng THẬT
 * SỰ compose cả hai module lại (`app.modules.ts`, spec SP2 §6: "boilerplate bật sẵn identity + notifications").
 *
 * Lịch sử: bản final-fixes-rereview (N7) đặt rule ở `notifications.config.ts`, đọc `c.identity` — sai HƯỚNG so với
 * SP2 rule 15 ("identity gọi notifications, không bao giờ ngược lại"), làm mọi tiến trình chỉ có namespace
 * `notifications` (không có `identity`) validate fail dù không sai gì thật (bảy spec test của notifications phải
 * import `identity.config.js` chỉ để né lỗi này).
 *
 * Sửa lần đầu của cleanup batch này chuyển rule sang `identity.config.ts` — ĐÚNG hướng phụ thuộc (identity được phép
 * phụ thuộc notifications), nhưng SAI ở một giả định khác: rất nhiều integration test mount identity (auth pool,
 * readiness, reconcile cron, telemetry…) mà KHÔNG mount `NotificationsModule`, nên `c.notifications` không tồn tại ở
 * đó — cùng lỗi validate, chỉ đổi phía. `pnpm test:int` cho thấy đây là tập hợp RỘNG HƠN tập test notifications-only
 * ban đầu, nên "identity luôn nạp notifications" không đúng với thực tế lắp ráp test của SP2 hôm nay.
 *
 * Vị trí đúng: một file riêng, KHÔNG thuộc file config của identity lẫn notifications, chỉ được `app.modules.ts`
 * (root compose CẢ HAI module thật) import. Không app test hẹp nào tự kéo nó vào (import module barrel của MỘT
 * module không kéo theo file này), nên rule chỉ chạy — và chỉ ĐƯỢC PHÉP chạy — khi cả hai namespace THẬT SỰ có mặt,
 * đúng ngữ nghĩa "composition-level rule", không phải rule của riêng module nào.
 *
 * S2-R68 (hiệu ứng-một-lần) và link xác nhận cho gửi lại (S2-R52) dựa vào việc dòng `email_deliveries` (giữ
 * `idempotency_key`) sống lâu hơn token mà key đó bảo vệ. `purge-deliveries` xoá theo `NOTIFICATIONS_RETENTION_DAYS`;
 * nếu ngắn hơn TTL token dài nhất, key được giải phóng trong khi link vẫn còn hiệu lực, nên cùng một link xác nhận
 * có thể gửi thêm email sau mỗi lần purge (final review M2).
 */
defineConfigRule('notifications-retention-outlives-token-ttl', (c) => {
  const retentionDays = c.notifications?.retentionDays;
  const emailTtlSec = c.identity?.emailTokenTtlSec;
  const resetTtlSec = c.identity?.resetTokenTtlSec;
  if (
    typeof retentionDays !== 'number' ||
    typeof emailTtlSec !== 'number' ||
    typeof resetTtlSec !== 'number'
  )
    return 'notifications retention rule needs the notifications and identity namespaces';
  const retentionSec = retentionDays * SECONDS_PER_DAY;
  const maxTtlSec = Math.max(emailTtlSec, resetTtlSec);
  return retentionSec > maxTtlSec
    ? undefined
    : `NOTIFICATIONS_RETENTION_DAYS (${retentionDays}d = ${retentionSec}s) must be greater than the longest auth token TTL (AUTH_EMAIL_TOKEN_TTL_SEC/AUTH_RESET_TOKEN_TTL_SEC, ${maxTtlSec}s)`;
});
