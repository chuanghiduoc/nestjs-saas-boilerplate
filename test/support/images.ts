import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function readImages(): Record<string, string> {
  const text = readFileSync(resolve('docker/images.env'), 'utf8');
  return Object.fromEntries(
    text
      .split('\n')
      .filter((l) => l.includes('='))
      .map((l) => {
        const i = l.indexOf('=');
        return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
      }),
  );
}
