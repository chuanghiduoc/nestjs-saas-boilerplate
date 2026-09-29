# 0018 — Entitlements: catalogue và gói trong code, bộ đếm theo kỳ, không cache ở v1

- Trạng thái: Đề xuất (plan 4A đang thực thi; chuyển "Chấp nhận" ở Task 14)
- Ngày: 2026-09-29
- Spec: [SP4](../superpowers/specs/2026-09-28-sp4-entitlements-design.md) r2 (chốt 2026-09-29, sửa §10.2 bước 2 sau review plan 4A); phán quyết R-X1…R-X24.

## Kết quả spike (plan 4A)

Chạy trên nhánh của plan 4A (sau khi 3A merge), hạ tầng Testcontainers của repo (Postgres 18, PgBouncer, Redis, Mailpit), Nest 12.1, Express 5.2.1. S4-T2 thuộc 4B (review money-security r1 đã chạy đạt trên PG 18.6; 4B giữ làm test hồi quy QU-2).

| # | Câu hỏi (spec §5) | Kết quả | Bằng chứng |
|---|---|---|---|
| S4-T1 | Interceptor route-scoped chạy sau `PoliciesGuard` bất kể thứ tự decorator, và bên trong `OrgScope.run` của `OrgScopeInterceptor` | Đạt: 4/4 PASS (member thiếu `org.delete` → 403 `forbidden`, interceptor không chạy, ở cả hai thứ tự decorator; owner → `interceptorOrg` = `sqlOrg` (`app_current_org()`) = org trên path, `via: MEMBERSHIP`). Hệ quả: `EntitlementInterceptor` không tự mở `OrgScope` (không cần fallback §5) | spike `interceptor-scope.e2e.spec.ts` (không commit); giữ thành test HT-1 ở Task 10 |
| S4-T3 | Participant chạy trong transaction tạo org, sau 3 role hệ thống, trước `MemberAdmission`, trong `OrgScope(newId)`; ném → không có org | Đạt: 2/2 PASS (hook thấy `inTransaction() = true`, `ctx.orgId()` = id org mới, `org_members` = 0; dòng `fixture_org_items` có FK tới `organizations` chèn trước COMMIT dưới FORCE RLS và commit cùng org, `organizations_bootstrap_ck` vẫn đạt; hook ném → 500 và không còn org) | spike `org-creation-hook.e2e.spec.ts` (không commit); giữ thành test ở Task 2 |
