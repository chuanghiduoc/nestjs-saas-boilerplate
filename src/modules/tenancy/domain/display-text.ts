const LINE_BREAKS = /[\r\n\u2028\u2029]+/g;

/**
 * Tên org/role/người vào thư (schema `displayName` của notifications chặn CR/LF và độ dài): tên org/role hợp lệ ở DB có
 * thể chứa ngắt dòng hoặc dài hơn trần hiển thị. Gộp ngắt dòng thành khoảng trắng, cắt theo code point (không tách đôi
 * cặp surrogate) ở tối đa `max` đơn vị UTF-16 (cách `z.string().max` đếm).
 */
export function oneLine(s: string, max: number): string {
  const flat = s.replace(LINE_BREAKS, ' ').trim();
  let out = '';
  for (const ch of flat) {
    if (out.length + ch.length > max) break;
    out += ch;
  }
  return out;
}
