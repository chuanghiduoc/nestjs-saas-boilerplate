export type OutgoingMail = {
  to: string;
  subject: string;
  html: string;
  text: string;
  messageId: string;
};

/** Gửi một thư; lỗi luôn là `MailSendError` đã chuẩn hoá (không PII). */
export abstract class MailTransport {
  abstract send(mail: OutgoingMail, signal: AbortSignal): Promise<void>;
}
