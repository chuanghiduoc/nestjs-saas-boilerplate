import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = 'src';
const ALLOW_FILE = /\.config\.ts$|\/config\/|\/migrations\//;
const PATTERNS: { name: string; re: RegExp }[] = [
  {
    name: 'cron expression',
    re: /['"`](\*|\d+|\*\/\d+)(\s+(\*|\d+|\*\/\d+|[\d,-]+)){4,5}['"`]/,
  },
  {
    name: 'http(s) URL',
    re: /['"`]https?:\/\/(?!schemas?\.|swc\.rs)[^'"`]+['"`]/,
  },
  {
    name: 'duration literal (ms)',
    re: /\b(setTimeout|setInterval)\([^,]+,\s*\d{3,}\s*\)/,
  },
  {
    name: 'ttl/timeout literal',
    re: /\b(ttl|timeout|timeoutMs|ttlMs|delayMs|limit|batchSize)\s*:\s*\d{2,}\b/i,
  },
  { name: 'blind cast', re: /\bas\s+(never|any)\b|:\s*any\b/ },
];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
}

describe('no hard-coded tunables or blind casts in src', () => {
  const offenders = files(ROOT)
    .filter((f) => !ALLOW_FILE.test(f.replaceAll('\\', '/')))
    .flatMap((f) =>
      readFileSync(f, 'utf8')
        .split('\n')
        .flatMap((line, i) =>
          PATTERNS.filter((p) => p.re.test(line)).map(
            (p) => `${f}:${i + 1} ${p.name}: ${line.trim()}`,
          ),
        ),
    );
  it('finds none', () => {
    expect(offenders).toEqual([]);
  });
});
