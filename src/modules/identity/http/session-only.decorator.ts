import { SetMetadata } from '@nestjs/common';

export const SESSION_ONLY = 'identity:sessionOnly';
/** Thao tác nhạy cảm: chỉ session (cookie/bearer), không nhận API key (spec §5.6.3). */
export const SessionOnly = (): ClassDecorator & MethodDecorator =>
  SetMetadata(SESSION_ONLY, true);
