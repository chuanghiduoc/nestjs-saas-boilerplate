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

  /**
   * Giờ hiện tại của container Mailpit (M4), đọc từ header `Date` chuẩn HTTP của chính response — không phải
   * đồng hồ host. `waitFor`/caller so `after` với `Created` (Mailpit tự đóng dấu, cũng theo đồng hồ container);
   * trên Docker Desktop/WSL2 đồng hồ VM container lệch sau đồng hồ host (đặc biệt sau sleep/resume), nên lấy
   * mốc `after` từ `Date.now()` của host so với `Created` của container có thể lệch: container đi sau khiến thư
   * mới bị lọc thành "cũ hơn after" và khẳng định "không có thư" pass giả dù thư đã gửi. Đọc header `Date` một
   * request bất kỳ (ở đây là `GET /api/v1/messages`, chỉ đọc, không xoá) đưa `after` về cùng đồng hồ với
   * `Created`. Header HTTP-date làm tròn xuống giây (không có mili-giây): làm tròn XUỐNG chỉ khiến `after` sớm
   * hơn thời điểm thật một chút — không bao giờ làm rớt thư mới thật khỏi bộ lọc `>= after`.
   */
  async now(): Promise<number> {
    const res = await fetch(`${this.apiUrl}/api/v1/messages`);
    if (!res.ok) throw new Error(`mailpit now() failed: ${res.status}`);
    await res.arrayBuffer(); // drain the body so the connection can be reused/closed cleanly
    const header = res.headers.get('date');
    if (!header) throw new Error('mailpit response is missing the Date header');
    const ms = Date.parse(header);
    if (Number.isNaN(ms))
      throw new Error(`mailpit response has an invalid Date header: ${header}`);
    return ms;
  }

  /**
   * Chờ thư tới `to`, lọc theo subject và chỉ thư tạo từ mốc `after` (ms epoch) nếu có. `after` so trực tiếp với
   * `Created` (đóng dấu bởi container Mailpit) — LUÔN lấy `after` từ `Mailpit#now()` (đồng hồ container), KHÔNG
   * BAO GIỜ từ `Date.now()` của host (M4: lệch đồng hồ host/container làm khẳng định "không có thư" pass giả).
   */
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
