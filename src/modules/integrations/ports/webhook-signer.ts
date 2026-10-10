/** Chữ ký Standard Webhooks (spec §8.3 bước 3): mọi secret còn hiệu lực, cách nhau bằng dấu cách, secret hiện hành trước. */
export abstract class WebhookSigner {
  abstract sign(input: {
    secrets: readonly string[];
    messageId: string;
    timestamp: Date;
    body: string;
  }): string;
}
