# 0012 — Hai chế độ phân trang: offset có trần và cursor

- Trạng thái: Đã chấp nhận
- Ngày: 2026-09-25

## Bối cảnh

UI dạng bảng cần trang và số lượng; feed, log, export cần đi tiếp ổn định mà không đếm toàn bộ tập dữ liệu.

## Quyết định

### Offset

`offsetPageQuery({ sortable })` kiểm tra page ≥ 1, pageSize trong config, `page × pageSize ≤ PAGINATION_MAX_OFFSET_ROWS`. Sort chỉ nhận allowlist, dấu `-` chỉ chiều giảm; output typed `{ field, direction }`, không đưa chuỗi client vào SQL.

`countUpTo` đếm qua subquery `LIMIT cap+1`; vượt trần thì trả `totalCount = cap`, `totalCountExact = false`. Đây là giới hạn số dòng đưa vào phép đếm, không bảo đảm mọi kế hoạch query chỉ đọc đúng từng ấy dòng vật lý. `innerSql` không được có ORDER BY/LIMIT; hiện là hợp đồng caller, chưa có guard.

Config bắt buộc `PAGINATION_TOTAL_COUNT_CAP >= PAGINATION_MAX_OFFSET_ROWS`. `hasMore` false nếu trang tiếp theo vượt trần. DTO: `{ url, data, page, pageSize, totalCount, totalCountExact, hasMore }`; url chỉ path, không query.

### Cursor

MikroORM dùng `findByCursor(entity, options)` hai tham số, với `first`, `after`, `orderBy`, `includeCount: false`; overfetch một dòng. Sort kết thúc bằng khoá duy nhất. DTO: `{ url, data, hasMore, nextCursor }`; hết trang thì cursor null.

Repository dùng `withClientCursor` và `txEm.current() ?? txEm.fork()` để giữ transaction/session RLS. Cursor chỉ hỗ trợ orderBy phẳng.

### Cursor không ký (R15)

Cursor là base64url của mảng JSON sort values, không có chữ ký. Guard kiểm tra arity và chỉ nhận giá trị nguyên thuỷ; where và RLS vẫn giới hạn dữ liệu. Sửa cursor chỉ thay điểm bắt đầu trong tập được phép.

| Đầu vào | Hành vi cần chặn |
| --- | --- |
| Không phải base64/JSON | CursorError → 400 invalid_cursor |
| Sai số phần tử hoặc không phải mảng | ORM có thể bỏ qua và trả trang đầu; guard từ chối trước |
| Leaf object/mảng | ORM có thể coi là cấu trúc query; guard chỉ cho giá trị nguyên thuỷ |
| Đúng arity nhưng sai kiểu | CursorError, lỗi Postgres lớp 22 hoặc 42883 → 400 khi có cursor |

Lỗi timeout/kết nối không bị đổi thành lỗi cursor. LIKE/ILIKE dùng `escapeLike` cho `\\`, `%`, `_` và bind parameter. Mỗi trường sort cần index tương ứng.

## Phương án đã loại

`findAndCount` không có trần đếm nên không chọn cho offset lớn. HMAC cursor thêm secret và xoay khoá mà không thay ranh giới phân quyền hiện tại. Không tự viết keyset khi MikroORM đã có.

## Hệ quả

Client muốn đi xa hơn trần offset phải dùng cursor. FixtureRepo chứa mẫu hai chế độ, đã kiểm tra mutation sai arity ở Task 12.

## Nguồn

Spec SP1 phần HTTP; báo cáo Task 12 và vòng sửa 1; R15. [ADR HTTP](0007-http-conventions.md).
