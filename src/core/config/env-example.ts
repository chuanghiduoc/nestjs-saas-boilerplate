import type { z } from 'zod';
import type { ConfigEntry } from './config.registry.js';

type Def = {
  type: string;
  innerType?: z.ZodType;
  in?: z.ZodType;
  defaultValue?: unknown;
};
const defOf = (s: z.ZodType): Def =>
  (s as unknown as { _zod: { def: Def } })._zod.def;

function describeField(
  field: z.ZodType,
):
  | { kind: 'default'; value: unknown }
  | { kind: 'optional' }
  | { kind: 'required' } {
  let cur: z.ZodType | undefined = field;
  while (cur) {
    const d = defOf(cur);
    if (d.type === 'default')
      return {
        kind: 'default',
        value:
          typeof d.defaultValue === 'function'
            ? (d.defaultValue as () => unknown)()
            : d.defaultValue,
      };
    if (d.type === 'optional') return { kind: 'optional' };
    if (d.type === 'pipe') cur = d.in;
    else if (d.type === 'nullable') cur = d.innerType;
    else break;
  }
  return { kind: 'required' };
}

export function renderEnvExample(entries: readonly ConfigEntry[]): string {
  const lines: string[] = [];
  for (const entry of entries) {
    for (const [key, envName] of Object.entries(entry.env)) {
      const field = entry.schema.shape[key] as z.ZodType;
      const info = describeField(field);
      const suffix =
        info.kind === 'required'
          ? ' (required)'
          : info.kind === 'optional'
            ? ' (optional)'
            : '';
      lines.push(`# [${entry.namespace}] ${field.description ?? key}${suffix}`);
      lines.push(
        `${envName}=${info.kind === 'default' ? String(info.value) : ''}`,
      );
      lines.push('');
    }
  }
  return lines.join('\n');
}
