/**
 * Điểm tuần tự hoá của mọi thao tác "đếm dưới khoá rồi thêm" theo org ở module khác (SP6 6A quota dung lượng R6-1, 6C giới
 * hạn endpoint R6-26; spec SP6 §5.3): khoá dòng org hiện tại `FOR NO KEY UPDATE` trong transaction của caller — cùng câu
 * SP3 §8.6 bước 1, cùng thứ tự khoá "org trước mọi bảng tenant". Không chặn INSERT vào bảng có FK tới org (FK chỉ lấy
 * `FOR KEY SHARE`). `false`: dòng org không còn (đã purge). Ngoài `UnitOfWork.run` hoặc ngoài `OrgScope` → ném.
 */
export abstract class OrgMutationLock {
  abstract lock(): Promise<boolean>;
}
