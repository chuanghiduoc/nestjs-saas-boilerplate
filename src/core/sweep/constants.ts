/**
 * Trần `p_limit` của mọi hàm definer (spec SP3 §6.14 DB-M3, SP6 §6.8; `RAISE` khi vượt). Migration viết cứng cùng giá trị
 * (migration không import code); test khoá hai phía. Chuyển từ tenancy ở SP6 6.0 (tenancy và `OrgSweepRunner` cùng dùng).
 */
export const DEFINER_LIMIT_MAX = 1000;
/** Con trỏ keyset lượt đầu của mọi lượt quét xuyên org (UUID nil, nhỏ hơn mọi UUID v7; SP3 CDX-8). */
export const PURGE_CURSOR_START = '00000000-0000-0000-0000-000000000000';
