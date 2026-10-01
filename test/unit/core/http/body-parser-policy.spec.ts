import { Injectable, Scope, type Type } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import {
  BodyParserOwner,
  BodyParserPolicy,
  type BodyParserOwnerMeta,
} from '../../../../src/core/http/body-parser-policy.js';

const JSON_TYPES = () => ['application/json'];
const owner = (
  meta: BodyParserOwnerMeta,
  scope = Scope.DEFAULT,
): Type<unknown> => {
  @Injectable({ scope })
  @BodyParserOwner(meta)
  class Owner {}
  return Owner;
};
const named = (name: string, prefix: string) =>
  owner({ owner: name, prefix: () => prefix, contentTypes: JSON_TYPES });
async function rules(...owners: Type<unknown>[]) {
  const ref = await Test.createTestingModule({
    imports: [DiscoveryModule],
    providers: [BodyParserPolicy, ...owners],
  }).compile();
  try {
    const policy = ref.get(BodyParserPolicy);
    return {
      rules: policy.rules(),
      ruleFor: (p: string) => policy.ruleFor(p)?.owner,
    };
  } finally {
    await ref.close();
  }
}

describe('BodyParserPolicy with many owners (spec SP6 §5.3 core/http, C-7)', () => {
  it('no owner → no rule; core parses every path', async () => {
    expect((await rules()).rules).toEqual([]);
  });
  it('two owners with disjoint prefixes; ruleFor matches by whole segment, lower-cased', async () => {
    const r = await rules(
      named('identity', '/api/auth'),
      owner({
        owner: 'files',
        prefix: () => '/v1/File-Uploads',
        contentTypes: () => ['application/octet-stream'],
      }),
    );
    expect(
      r.rules.map((x) => [x.owner, x.prefix, x.contentTypes]).sort(),
    ).toEqual(
      [
        ['files', '/v1/file-uploads', ['application/octet-stream']],
        ['identity', '/api/auth', ['application/json']],
      ].sort(),
    );
    expect(r.ruleFor('/api/auth')).toBe('identity');
    expect(r.ruleFor('/api/auth/sign-in/email')).toBe('identity');
    expect(r.ruleFor('/v1/file-uploads/tok')).toBe('files');
    expect(r.ruleFor('/v1/orgs')).toBeUndefined();
  });
  it('a nested prefix fails boot naming both owners', async () => {
    const err = await rules(
      named('a', '/owned'),
      named('b', '/owned/deeper'),
    ).then(
      () => undefined,
      (e: unknown) => String(e),
    );
    expect(err).toMatch(/Body parser prefixes overlap/);
    expect(err).toMatch(/"\/owned" \(a\)/);
    expect(err).toMatch(/"\/owned\/deeper" \(b\)/);
  });
  it('prefixes that differ only by case overlap (Express routes case-insensitively; Review Focus 1)', async () => {
    await expect(
      rules(named('a', '/Uploads'), named('b', '/uploads')),
    ).rejects.toThrow(/overlap/);
  });
  it('a sibling prefix that only shares characters does not overlap (Review Focus 1)', async () => {
    const r = await rules(named('a', '/api/auth'), named('b', '/api/authx'));
    expect([r.ruleFor('/api/authx/y'), r.ruleFor('/api/auth/y')]).toEqual([
      'b',
      'a',
    ]);
  });
  it.each(['', 'api/auth', '/', '/api/auth/', '/api?x=1', '/api#frag'])(
    'fails boot on malformed prefix %j',
    async (prefix) => {
      await expect(rules(named('a', prefix))).rejects.toThrow(
        /prefix must start with "\/"/,
      );
    },
  );
  it.each([
    [[]],
    [['Application/JSON']],
    [['application/json; charset=utf-8']],
  ])('fails boot on content types %j', async (types) => {
    await expect(
      rules(
        owner({ owner: 'a', prefix: () => '/x', contentTypes: () => types }),
      ),
    ).rejects.toThrow(
      /contentTypes must be lower-case media types without parameters/,
    );
  });
  it('fails boot on a malformed owner name or a request-scoped owner', async () => {
    await expect(rules(named('Bad Owner', '/x'))).rejects.toThrow(
      /owner must match/,
    );
    await expect(
      rules(
        owner(
          { owner: 'a', prefix: () => '/x', contentTypes: JSON_TYPES },
          Scope.REQUEST,
        ),
      ),
    ).rejects.toThrow(/must be on a singleton provider/);
  });
});
