import { describe, expect, it } from 'vitest';
import { BodyParserPolicy } from '../../../../src/core/http/body-parser-policy.js';

describe('BodyParserPolicy', () => {
  it('has no skip prefix when no module owns one', () => {
    expect(new BodyParserPolicy().skipPrefix()).toBeUndefined();
  });
  it('keeps a well-formed prefix', () => {
    expect(new BodyParserPolicy('/api/auth').skipPrefix()).toBe('/api/auth');
  });
  it.each(['', 'api/auth', '/', '/api/auth/', '/api?x=1', '/api#frag'])(
    'fails loudly at bootstrap on malformed prefix %j',
    (prefix) => {
      expect(() => new BodyParserPolicy(prefix)).toThrow(
        /HTTP_BODY_PARSER_SKIP_PREFIX/,
      );
    },
  );
});
