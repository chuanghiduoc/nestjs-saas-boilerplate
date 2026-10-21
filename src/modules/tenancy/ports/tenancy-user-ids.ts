/**
 * Ánh xạ `principal.id` (subject theo AUTH_MODE: auth."user".id ở local/hybrid, `sub` ở external) → `tenancy_users.public_id`
 * (SP3 §14; audit 6B ghi snapshot `actor_user_id`). Không khoá, không tạo dòng. Subject không có dòng (chưa chạm tenancy,
 * đã xoá tài khoản) hoặc không đúng dạng của mode (không phải UUID ở local/hybrid) → vắng trong map, không bao giờ 22P02.
 * Khoá của map là chuỗi subject đúng như caller truyền. Quá `AUTH_DIRECTORY_BATCH_MAX` subject một lần → ném (lỗi của caller).
 */
export abstract class TenancyUserIds {
  abstract publicIdsBySubjects(
    subjects: readonly string[],
  ): Promise<ReadonlyMap<string, string>>;
}
