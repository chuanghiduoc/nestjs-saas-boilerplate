import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Paginator,
  cursorPageQuery,
  offsetPageQuery,
  paginationConfig,
} from '../../../../src/core/http/index.js';
import type { RequestContext } from '../../../../src/core/context/index.js';

const ctx = { path: () => '/api/v1/admin/users' } as unknown as RequestContext;
const p = new Paginator(ctx, {
  maxPageSize: 100,
  defaultPageSize: 20,
  maxOffsetRows: 100,
  totalCountCap: 100,
});

describe('Paginator', () => {
  it('offset: exact totalCount below cap', () => {
    expect(p.offset([{ id: '1' }], { page: 1, pageSize: 20 }, 42)).toEqual({
      url: '/api/v1/admin/users',
      data: [{ id: '1' }],
      page: 1,
      pageSize: 20,
      totalCount: 42,
      totalCountExact: true,
      hasMore: true,
    });
  });
  it('offset: last page has hasMore=false', () => {
    expect(p.offset([], { page: 3, pageSize: 20 }, 42).hasMore).toBe(false);
  });
  it('offset: above cap reports cap with totalCountExact=false', () => {
    expect(p.offset([], { page: 1, pageSize: 20 }, 101)).toMatchObject({
      totalCount: 100,
      totalCountExact: false,
      hasMore: true,
    });
  });
  it('offset: never promises a page beyond maxOffsetRows', () => {
    expect(p.offset([], { page: 5, pageSize: 20 }, 101).hasMore).toBe(false);
  });
  it('cursor: flat shape, nextCursor null when no more', () => {
    expect(
      p.cursor([{ id: 'a' }], { hasMore: true, nextCursor: 'c1' }),
    ).toEqual({
      url: '/api/v1/admin/users',
      data: [{ id: 'a' }],
      hasMore: true,
      nextCursor: 'c1',
    });
    expect(
      p.cursor([], { hasMore: false, nextCursor: 'stale' }).nextCursor,
    ).toBeNull();
  });
  it('fails loudly outside an HTTP request context', () => {
    const noCtx = { path: () => undefined } as unknown as RequestContext;
    const q = new Paginator(noCtx, {
      maxPageSize: 100,
      defaultPageSize: 20,
      maxOffsetRows: 100,
      totalCountCap: 100,
    });
    expect(() => q.cursor([], { hasMore: false, nextCursor: null })).toThrow(
      /outside of an HTTP request/,
    );
  });
});

describe('offsetPageQuery', () => {
  const Q = offsetPageQuery({ sortable: ['name', 'createdAt'] as const });
  it('applies defaults from config', () => {
    expect(Q.parse({})).toEqual({ page: 1, pageSize: 20 });
  });
  it('coerces query strings and parses sort into an allowlisted field + direction', () => {
    expect(Q.parse({ page: '2', pageSize: '5', sort: '-createdAt' })).toEqual({
      page: 2,
      pageSize: 5,
      sort: { field: 'createdAt', direction: 'desc' },
    });
    expect(Q.parse({ sort: 'name' }).sort).toEqual({
      field: 'name',
      direction: 'asc',
    });
  });
  it('rejects sort fields outside the allowlist (no SQL reaches the query)', () => {
    for (const sort of [
      'email',
      'name; DROP TABLE users',
      'name desc',
      '--name',
      '',
    ])
      expect(Q.safeParse({ sort }).success).toBe(false);
  });
  it('rejects pageSize above max and pages beyond maxOffsetRows', () => {
    expect(Q.safeParse({ pageSize: '101' }).success).toBe(false);
    expect(Q.safeParse({ page: '0' }).success).toBe(false);
    expect(Q.safeParse({ page: '101', pageSize: '100' }).success).toBe(false);
    expect(Q.safeParse({ page: '100', pageSize: '100' }).success).toBe(true);
  });
});

describe('cursorPageQuery', () => {
  const Q = cursorPageQuery();
  it('defaults limit and bounds it', () => {
    expect(Q.parse({})).toEqual({ limit: 20 });
    expect(Q.safeParse({ limit: '101' }).success).toBe(false);
    expect(Q.safeParse({ limit: '0' }).success).toBe(false);
    expect(Q.safeParse({ cursor: '' }).success).toBe(false);
  });
});

describe('paginationConfig', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('requires the count cap to cover every reachable offset page', () => {
    vi.stubEnv('PAGINATION_TOTAL_COUNT_CAP', '100');
    vi.stubEnv('PAGINATION_MAX_OFFSET_ROWS', '10000');
    expect(() => paginationConfig()).toThrow(/PAGINATION_TOTAL_COUNT_CAP/);
    vi.stubEnv('PAGINATION_MAX_OFFSET_ROWS', '100');
    expect(paginationConfig().totalCountCap).toBe(100);
  });
  it('requires the default page size to be within the max', () => {
    vi.stubEnv('PAGINATION_DEFAULT_PAGE_SIZE', '500');
    expect(() => paginationConfig()).toThrow(/PAGINATION_DEFAULT_PAGE_SIZE/);
  });
});
