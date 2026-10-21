import { describe, expect, it } from 'vitest';
import {
  EXAMPLE_PROJECT_DESCRIPTION_MAX_LENGTH as DMAX,
  EXAMPLE_PROJECT_NAME_MAX_LENGTH as NMAX,
} from '../../../../src/features/example/constants.js';
import {
  decodeProjectCursor,
  encodeProjectCursor,
} from '../../../../src/features/example/http/project-cursor.js';
import {
  CreateProjectBody,
  PatchProjectBody,
  ProjectListQuery,
  projectIdOrNotFound,
} from '../../../../src/features/example/http/schemas.js';
import { AppError } from '../../../../src/core/errors/index.js';
import { paginationConfig } from '../../../../src/core/http/index.js';

describe('project schemas (spec §9.3, EX-U2)', () => {
  it('name: trimmed, 1..100', () => {
    expect(CreateProjectBody.parse({ name: '  Web  ' })).toEqual({
      name: 'Web',
      description: null,
    });
    expect(CreateProjectBody.safeParse({ name: '   ' }).success).toBe(false);
    expect(
      CreateProjectBody.safeParse({ name: 'x'.repeat(NMAX) }).success,
    ).toBe(true);
    expect(
      CreateProjectBody.safeParse({ name: 'x'.repeat(NMAX + 1) }).success,
    ).toBe(false);
  });
  it('description: "" and whitespace become null; 1000 passes, 1001 fails', () => {
    expect(
      CreateProjectBody.parse({ name: 'a', description: '' }).description,
    ).toBeNull();
    expect(
      CreateProjectBody.parse({ name: 'a', description: '  ' }).description,
    ).toBeNull();
    expect(
      CreateProjectBody.parse({ name: 'a', description: null }).description,
    ).toBeNull();
    expect(
      CreateProjectBody.safeParse({ name: 'a', description: 'd'.repeat(DMAX) })
        .success,
    ).toBe(true);
    expect(
      CreateProjectBody.safeParse({
        name: 'a',
        description: 'd'.repeat(DMAX + 1),
      }).success,
    ).toBe(false);
  });
  it('unknown fields are refused, status is never patchable', () => {
    expect(
      CreateProjectBody.safeParse({ name: 'a', status: 'ARCHIVED' }).success,
    ).toBe(false);
    expect(PatchProjectBody.safeParse({ status: 'ARCHIVED' }).success).toBe(
      false,
    );
    expect(PatchProjectBody.parse({ description: '' })).toEqual({
      description: null,
    });
  });
  it('list query: limit capped by PAGINATION_MAX_PAGE_SIZE, status enum', () => {
    // Unit project không có infra (`applyTestEnv` đọc container): schema dựng từ mặc định của `paginationConfig`.
    const max = paginationConfig().maxPageSize;
    expect(ProjectListQuery.parse({ limit: String(max) }).limit).toBe(max);
    expect(ProjectListQuery.safeParse({ limit: String(max + 1) }).success).toBe(
      false,
    );
    expect(ProjectListQuery.safeParse({ status: 'DELETED' }).success).toBe(
      false,
    );
    expect(ProjectListQuery.parse({ status: 'ARCHIVED' }).status).toBe(
      'ARCHIVED',
    );
  });
  it('projectIdOrNotFound: malformed → 404 (D7-3), upper case normalised', () => {
    expect(() => projectIdOrNotFound('nope')).toThrow(AppError);
    expect(projectIdOrNotFound('019DD1A5-0000-7000-8000-000000000001')).toBe(
      '019dd1a5-0000-7000-8000-000000000001',
    );
  });
});

describe('project cursor (D7-1, EX-U10, Review Focus 1)', () => {
  const id = '019dd1a5-0000-7000-8000-000000000001';
  it('round-trips', () => {
    expect(decodeProjectCursor(encodeProjectCursor(id))).toBe(id);
  });
  it.each([
    ['not base64url', '***'],
    ['non-canonical base64url', `${encodeProjectCursor(id)}=`],
    ['not JSON', Buffer.from('nope').toString('base64url')],
    [
      'two elements',
      Buffer.from(JSON.stringify([id, id])).toString('base64url'),
    ],
    [
      'an object leaf',
      Buffer.from(JSON.stringify([{ $ne: null }])).toString('base64url'),
    ],
    ['not a uuid', Buffer.from(JSON.stringify(['x'])).toString('base64url')],
    ['very long', 'A'.repeat(10_000)],
  ])('%s → 400 invalid_cursor', (_label, raw) => {
    try {
      decodeProjectCursor(raw);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).error.code).toBe('invalid_cursor');
    }
  });
});
