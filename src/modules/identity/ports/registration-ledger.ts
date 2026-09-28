/** Sổ "đã phát event identity.user.registered chưa" trên chính dòng user (marker bền, spec §5.10). */
export abstract class RegistrationLedger {
  abstract unmarked(graceSec: number, limit: number): Promise<string[]>;
  abstract mark(userIds: readonly string[]): Promise<number>;
  abstract oldestUnmarkedAgeSec(): Promise<number | null>;
}
