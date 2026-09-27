import { z } from 'zod';
import { getInfra } from './infra.js';

const POLL_MS = 100;
const DEFAULT_TIMEOUT_MS = 15_000;
const Address = z.object({ Address: z.string(), Name: z.string() });
const Summary = z.object({
  ID: z.string(),
  Subject: z.string(),
  To: z.array(Address),
  Created: z.string(),
});
const SearchResult = z.object({ messages: z.array(Summary) });
// `GET /api/v1/message/{id}` không có `Created` (chỉ có `Date` của header), nên không extend Summary
// (đã kiểm trên container axllent/mailpit:v1.31.2).
const Message = z.object({
  ID: z.string(),
  Subject: z.string(),
  To: z.array(Address),
  HTML: z.string(),
  Text: z.string(),
});
export type MailpitSummary = z.infer<typeof Summary>;
export type MailpitMessage = z.infer<typeof Message>;

/** Client Mailpit API v1 (`/api/v1/search`, `/api/v1/message/{id}`, `DELETE /api/v1/messages`). */
export class Mailpit {
  constructor(private readonly apiUrl: string) {}

  async clear(): Promise<void> {
    const res = await fetch(`${this.apiUrl}/api/v1/messages`, {
      method: 'DELETE',
    });
    if (!res.ok) throw new Error(`mailpit clear failed: ${res.status}`);
  }

  async messages(to: string): Promise<MailpitSummary[]> {
    const res = await fetch(
      `${this.apiUrl}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`,
    );
    if (!res.ok) throw new Error(`mailpit search failed: ${res.status}`);
    return SearchResult.parse(await res.json()).messages;
  }

  async message(id: string): Promise<MailpitMessage> {
    const res = await fetch(
      `${this.apiUrl}/api/v1/message/${encodeURIComponent(id)}`,
    );
    if (!res.ok) throw new Error(`mailpit message failed: ${res.status}`);
    return Message.parse(await res.json());
  }

  /** Chờ thư tới `to`, lọc theo subject và chỉ thư tạo từ mốc `after` (ms epoch) nếu có. */
  async waitFor(
    to: string,
    opts: { subject?: RegExp; timeoutMs?: number; after?: number } = {},
  ): Promise<MailpitMessage> {
    const deadline = Date.now() + (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    for (;;) {
      const hit = (await this.messages(to)).find(
        (m) =>
          (!opts.subject || opts.subject.test(m.Subject)) &&
          (opts.after === undefined || Date.parse(m.Created) >= opts.after),
      );
      if (hit) return this.message(hit.ID);
      if (Date.now() > deadline)
        throw new Error(`no mail to ${to} within timeout`);
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }
}

export const mailpitFromInfra = (): Mailpit =>
  new Mailpit(getInfra().mailpit.apiUrl);
