import { MailSendError, type MailErrorCode } from '../errors.js';

const SMTP_PERMANENT_FROM = 500;
const SMTP_TRANSIENT_FROM = 400;
const TIMEOUT_CODES = new Set(['ETIMEDOUT']);
const CONNECTION_CODES = new Set([
  'ECONNECTION',
  'ECONNREFUSED',
  'ECONNRESET',
  'ESOCKET',
  'EDNS',
  'ETLS',
]);
/** Chỉ giữ động từ SMTP (vd. `RCPT TO`); phần sau có thể chứa địa chỉ. */
const SMTP_VERB =
  /^(RCPT TO|MAIL FROM|EHLO|HELO|DATA|AUTH|STARTTLS|RSET|NOOP|QUIT|CONN)(?=$|[\s:])/;

const prop = (err: unknown, key: string): unknown =>
  typeof err === 'object' && err !== null && key in err
    ? Reflect.get(err, key)
    : undefined;

/**
 * Lỗi của nodemailer mang `response`, `responseCode`, `command`, `rejected`, `rejectedErrors`, `envelope`
 * (spec A.11), nhiều field chứa địa chỉ email. Chỉ giữ mã phân loại, mã phản hồi số và động từ SMTP;
 * không giữ lỗi gốc làm `cause`.
 */
export function toMailSendError(err: unknown): MailSendError {
  const responseCode = prop(err, 'responseCode');
  const code = prop(err, 'code');
  const rawCommand = prop(err, 'command');
  const command =
    typeof rawCommand === 'string'
      ? SMTP_VERB.exec(rawCommand)?.[0]
      : undefined;
  let kind: MailErrorCode =
    err instanceof MailSendError ? err.code : 'SMTP_TRANSIENT';
  if (typeof responseCode === 'number' && responseCode >= SMTP_PERMANENT_FROM)
    kind = 'SMTP_PERMANENT';
  else if (
    typeof responseCode === 'number' &&
    responseCode >= SMTP_TRANSIENT_FROM
  )
    kind = 'SMTP_TRANSIENT';
  else if (typeof code === 'string' && TIMEOUT_CODES.has(code))
    kind = 'SMTP_TIMEOUT';
  else if (typeof code === 'string' && CONNECTION_CODES.has(code))
    kind = 'SMTP_CONNECTION';
  return new MailSendError(
    kind,
    typeof responseCode === 'number' ? responseCode : undefined,
    command,
  );
}
