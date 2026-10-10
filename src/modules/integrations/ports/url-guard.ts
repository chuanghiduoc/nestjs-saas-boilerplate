/** Lý do chỉ để log/metric; client chỉ nhận `422 webhook_url_not_allowed` với detail chung (spec §8.3 bước 1). */
export type UrlCheck =
  | { ok: true; url: string }
  | { ok: false; reason: 'INVALID' | 'NOT_ALLOWED' | 'UNRESOLVABLE' };

/**
 * Kiểm URL lúc tạo và lúc sửa (spec SP6 §8.3 bước 1). Chỉ để phản hồi sớm: lớp chặn thật là `ssrfLookup` lúc connect của
 * `HttpClient` (DNS rebinding, W-22). Gọi NGOÀI transaction (DNS là I/O ngoài, spec §3.2 luật 3).
 */
export abstract class UrlGuard {
  abstract check(raw: string): Promise<UrlCheck>;
}
