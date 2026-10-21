import { HttpStatus } from '@nestjs/common';
import { defineConstraintErrors } from '../../core/database/index.js';
import { defineErrorCodes } from '../../core/errors/index.js';

/** Mã do feature mẫu sở hữu (spec SP7 §9.4, D7-2): key mang tiền tố feature vì `code = key.toLowerCase()`. */
export const ExampleErrors = defineErrorCodes({
  EXAMPLE_PROJECT_NAME_TAKEN: {
    status: HttpStatus.CONFLICT,
    title: 'A project with this name already exists',
  },
  EXAMPLE_PROJECT_NOT_ACTIVE: {
    status: HttpStatus.CONFLICT,
    title: 'The project is not active',
  },
  EXAMPLE_PROJECT_NOT_ARCHIVED: {
    status: HttpStatus.CONFLICT,
    title: 'The project is not archived',
  },
});

/** Tên trùng (không phân biệt hoa thường) là `409` có mã, không lộ tên constraint. */
defineConstraintErrors({
  example_projects_name_uq: ExampleErrors.EXAMPLE_PROJECT_NAME_TAKEN,
});
