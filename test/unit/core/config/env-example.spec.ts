import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { renderEnvExample } from '../../../../src/core/config/index.js';

describe('renderEnvExample', () => {
  it('prints raw defaults (before transform), marks required and optional correctly', () => {
    const out = renderEnvExample([
      {
        namespace: 'x',
        env: {
          port: 'X_PORT',
          list: 'X_LIST',
          secret: 'X_SECRET',
          note: 'X_NOTE',
        },
        schema: z.object({
          port: z.coerce.number().default(8080).describe('Port'),
          list: z
            .string()
            .default('a,b')
            .transform((s) => s.split(','))
            .describe('List'),
          secret: z.string().describe('Secret'),
          note: z.string().optional().describe('Note'),
        }),
      },
    ]);
    expect(out).toContain('# [x] Port\nX_PORT=8080');
    expect(out).toContain('# [x] List\nX_LIST=a,b');
    expect(out).toContain('# [x] Secret (required)\nX_SECRET=');
    expect(out).toContain('# [x] Note (optional)\nX_NOTE=');
    expect(out).not.toContain('[object Object]');
  });
});
