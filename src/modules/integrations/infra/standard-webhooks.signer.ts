import { Injectable } from '@nestjs/common';
import { Webhook } from 'standardwebhooks';
import { WebhookSigner } from '../ports/webhook-signer.js';

/** Luật kiến trúc 21: `standardwebhooks` chỉ được import ở `integrations/infra`. */
@Injectable()
export class StandardWebhooksSigner extends WebhookSigner {
  sign(input: {
    secrets: readonly string[];
    messageId: string;
    timestamp: Date;
    body: string;
  }): string {
    if (input.secrets.length === 0)
      throw new Error('at least one signing secret is required');
    return input.secrets
      .map((s) =>
        new Webhook(s).sign(input.messageId, input.timestamp, input.body),
      )
      .join(' ');
  }
}
