import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** Hằng số thuật toán (định dạng token v1), không phải giá trị tuỳ chỉnh. */
const VERSION = 'v1';
const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
export const FIELD_KEY_BYTES = 32;
const TAG_BYTES = 16;
const TOKEN_PARTS = 5;

/** Mọi lỗi của FieldCipher; message chỉ chứa kid, không bao giờ chứa key hay plaintext. */
export class FieldCipherError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'FieldCipherError';
  }
}

/** Độ dài key (byte) sau khi decode base64; dùng chung cho config và constructor. */
export const fieldKeyLength = (b64: string): number =>
  Buffer.from(b64, 'base64').length;

/**
 * AES-256-GCM theo field, keyring có kid để xoay khoá: kid active mã hoá, mọi kid trong ring giải mã được.
 * `aad` (`table:column:orgId:pk`) cùng version và kid được gắn vào tag, nên ciphertext chép sang
 * hàng/cột/org khác hoặc bị đổi kid đều giải mã thất bại. Đây không phải envelope encryption qua KMS.
 */
export class FieldCipher {
  private readonly keys: Map<string, Buffer>;

  constructor(
    keys: Readonly<Record<string, string>>,
    private readonly activeKid: string,
  ) {
    this.keys = new Map(
      Object.entries(keys).map(([kid, b64]) => {
        const key = Buffer.from(b64, 'base64');
        if (key.length !== FIELD_KEY_BYTES)
          throw new FieldCipherError(
            `Encryption key "${kid}" must be ${FIELD_KEY_BYTES} bytes`,
          );
        return [kid, key];
      }),
    );
    if (!this.keys.has(activeKid))
      throw new FieldCipherError(
        `Encryption active key "${activeKid}" is not in the keyring`,
      );
  }

  private aadOf(kid: string, aad: string): Buffer {
    return Buffer.from(`${VERSION}.${kid}.${aad}`, 'utf8');
  }

  encrypt(plain: string, aad: string): string {
    const key = this.keys.get(this.activeKid);
    if (!key)
      throw new FieldCipherError(
        `Encryption active key "${this.activeKid}" is not in the keyring`,
      );
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGO, key, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(this.aadOf(this.activeKid, aad));
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return [
      VERSION,
      this.activeKid,
      iv.toString('base64url'),
      ct.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
    ].join('.');
  }

  decrypt(token: string, aad: string): string {
    const parts = token.split('.');
    const [version, kid, iv, ct, tag] = parts;
    if (
      parts.length !== TOKEN_PARTS ||
      version !== VERSION ||
      !kid ||
      !iv ||
      ct === undefined ||
      !tag
    )
      throw new FieldCipherError('Malformed encrypted value');
    const key = this.keys.get(kid);
    if (!key)
      throw new FieldCipherError(`Encrypted value uses unknown key "${kid}"`);
    const ivBuf = Buffer.from(iv, 'base64url');
    const tagBuf = Buffer.from(tag, 'base64url');
    if (ivBuf.length !== IV_BYTES || tagBuf.length !== TAG_BYTES)
      throw new FieldCipherError('Malformed encrypted value');
    const decipher = createDecipheriv(ALGO, key, ivBuf, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(this.aadOf(kid, aad));
    decipher.setAuthTag(tagBuf);
    try {
      return Buffer.concat([
        decipher.update(Buffer.from(ct, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } catch (err) {
      throw new FieldCipherError(
        `Encrypted value authentication failed (key "${kid}"): tampered, truncated, or bound to another record`,
        { cause: err },
      );
    }
  }
}
