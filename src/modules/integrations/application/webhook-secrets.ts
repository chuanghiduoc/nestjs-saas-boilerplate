import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { FieldCipher } from '../../../core/security/index.js';
import { WEBHOOK_SECRET_BYTES, WEBHOOK_SECRET_PREFIX } from '../constants.js';

type Binding = { orgId: string; secretPublicId: string };
/** AAD của spec §6.5: ciphertext chép sang dòng/org khác thì giải mã thất bại. */
const aadOf = (b: Binding): string =>
  `webhook_endpoint_secrets:secret_enc:${b.orgId}:${b.secretPublicId}`;

/** Secret ký là 256 bit ngẫu nhiên, lưu mã hoá (S6-A29: ký cần secret gốc, không lưu băm); bản rõ chỉ trả một lần. */
@Injectable()
export class WebhookSecrets {
  constructor(private readonly cipher: FieldCipher) {}

  generate(): string {
    return `${WEBHOOK_SECRET_PREFIX}${randomBytes(WEBHOOK_SECRET_BYTES).toString('base64')}`;
  }
  seal(secret: string, b: Binding): string {
    return this.cipher.encrypt(secret, aadOf(b));
  }
  /**
   * `FieldCipherError` (kid đã retire, ciphertext hỏng) ném lên caller. `DeliverWebhookHandler` bắt nó lúc claim và ghi lỗi
   * của ta `SECRET_UNAVAILABLE` trong chính transaction claim (log ERROR `webhook_secret_unreadable`; lần thứ
   * `INTEGRATIONS_MAX_LOCAL_FAILURES` → `EXHAUSTED`; khôi phục: sửa keyring rồi `recover` — spec §14, R-X35).
   */
  open(token: string, b: Binding): string {
    return this.cipher.decrypt(token, aadOf(b));
  }
}
