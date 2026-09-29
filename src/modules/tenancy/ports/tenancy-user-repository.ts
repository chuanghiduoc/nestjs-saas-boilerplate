export type TenancySubject =
  | { kind: 'AUTH_USER'; authUserId: string }
  | { kind: 'EXTERNAL'; externalSubject: string };
export type TenancyUserRef = { id: string; publicId: string };

export abstract class TenancyUserRepository {
  /** Không khoá, không tạo: đường nóng và `GET /v1/orgs` không bao giờ tạo dòng (Review Focus 2). */
  abstract find(s: TenancySubject): Promise<TenancyUserRef | undefined>;
  /** Tạo lười + khoá `FOR NO KEY UPDATE` trong transaction của caller (T-25, T-6, T-7). */
  abstract upsertAndLock(s: TenancySubject): Promise<TenancyUserRef>;
  abstract deleteById(id: string): Promise<void>;
}
