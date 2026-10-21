import type { ErrorCode } from '../../../core/errors/index.js';
import { ExampleErrors } from '../errors.js';

/** Máy trạng thái `Project` (spec SP7 §8.1). DB ép tập trạng thái bằng `example_projects_status_ck`. */
export const PROJECT_STATUSES = ['ACTIVE', 'ARCHIVED'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];
export type ProjectCommand =
  'ARCHIVE' | 'UNARCHIVE' | 'UPDATE' | 'REMOVE' | 'PURGE';
export type Transition =
  | { kind: 'OK'; next: ProjectStatus | 'DELETED' }
  | { kind: 'REJECTED'; code: ErrorCode };

const ok = (next: ProjectStatus | 'DELETED'): Transition => ({
  kind: 'OK',
  next,
});
const rejected = (code: ErrorCode): Transition => ({ kind: 'REJECTED', code });

function unknownCommand(command: never): never {
  throw new Error(`unknown project command ${String(command)}`);
}

/**
 * Bảng 8.1. Service gọi sau khi đã khoá dòng (`FOR NO KEY UPDATE`, D7-4), nên đây là nơi quyết định, không chỉ trả lỗi đẹp.
 * `PURGE` từ `ACTIVE` không có đường runtime (câu xoá của job chỉ chọn `ARCHIVED`); mã ở đó chỉ để `switch` vét cạn (D7-14).
 */
export function transition(
  status: ProjectStatus,
  command: ProjectCommand,
): Transition {
  switch (status) {
    case 'ACTIVE':
      switch (command) {
        case 'ARCHIVE':
          return ok('ARCHIVED');
        case 'UNARCHIVE':
          return rejected(ExampleErrors.EXAMPLE_PROJECT_NOT_ARCHIVED);
        case 'UPDATE':
          return ok('ACTIVE');
        case 'REMOVE':
          return ok('DELETED');
        case 'PURGE':
          return rejected(ExampleErrors.EXAMPLE_PROJECT_NOT_ARCHIVED);
        default:
          return unknownCommand(command);
      }
    case 'ARCHIVED':
      switch (command) {
        case 'ARCHIVE':
          return rejected(ExampleErrors.EXAMPLE_PROJECT_NOT_ACTIVE);
        case 'UNARCHIVE':
          return ok('ACTIVE');
        case 'UPDATE':
          return rejected(ExampleErrors.EXAMPLE_PROJECT_NOT_ACTIVE);
        case 'REMOVE':
          return ok('DELETED');
        case 'PURGE':
          return ok('DELETED');
        default:
          return unknownCommand(command);
      }
    default: {
      const unknown: never = status;
      throw new Error(`unknown project status ${String(unknown)}`);
    }
  }
}
