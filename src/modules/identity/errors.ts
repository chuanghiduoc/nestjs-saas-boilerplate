import { HttpStatus } from '@nestjs/common';
import { defineErrorCodes } from '../../core/errors/index.js';

export const IdentityErrors = defineErrorCodes({
  INVALID_CREDENTIALS: {
    status: HttpStatus.UNAUTHORIZED,
    title: 'Invalid email or password',
  },
  INVALID_TWO_FACTOR_CODE: {
    status: HttpStatus.UNAUTHORIZED,
    title: 'Invalid two-factor code',
  },
  EMAIL_NOT_VERIFIED: {
    status: HttpStatus.FORBIDDEN,
    title: 'Email address is not verified',
  },
  ACCOUNT_DISABLED: {
    status: HttpStatus.FORBIDDEN,
    title: 'Account is disabled',
  },
  REAUTHENTICATION_REQUIRED: {
    status: HttpStatus.FORBIDDEN,
    title: 'Sign in again to continue',
  },
  ORIGIN_NOT_ALLOWED: {
    status: HttpStatus.FORBIDDEN,
    title: 'Request origin is not allowed',
  },
  AMBIGUOUS_CREDENTIALS: {
    status: HttpStatus.BAD_REQUEST,
    title: 'Request carries more than one credential',
  },
  INVALID_OR_EXPIRED_TOKEN: {
    status: HttpStatus.BAD_REQUEST,
    title: 'Link is invalid, expired or already used',
  },
  EMAIL_TAKEN: {
    status: HttpStatus.CONFLICT,
    title: 'Email address is already in use',
  },
});
