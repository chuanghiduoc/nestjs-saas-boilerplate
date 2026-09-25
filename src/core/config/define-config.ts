import { registerAs } from '@nestjs/config';
import type { z } from 'zod';
import { registerConfigEntry } from './config.registry.js';

export class ConfigValidationError extends Error {
  constructor(
    readonly namespace: string,
    readonly issues: { env: string; message: string }[],
  ) {
    super(
      `Invalid config "${namespace}": ${issues.map((i) => `${i.env}: ${i.message}`).join('; ')}`,
    );
    this.name = 'ConfigValidationError';
  }
}

export function parseConfig<S extends z.ZodObject>(
  namespace: string,
  env: Record<string, string>,
  schema: S,
): z.infer<S> {
  const raw = Object.fromEntries(
    Object.entries(env).map(([key, name]) => [key, process.env[name]]),
  );
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigValidationError(
      namespace,
      parsed.error.issues.map((issue) => {
        const key = String(issue.path[0]);
        return { env: env[key] ?? key, message: issue.message };
      }),
    );
  }
  return parsed.data;
}

export function defineConfig<S extends z.ZodObject>(
  namespace: string,
  env: { [K in keyof z.infer<S>]: string },
  schema: S,
) {
  const envMap = env as Record<string, string>;
  const factory = registerAs(namespace, (): z.infer<S> =>
    parseConfig(namespace, envMap, schema),
  );
  registerConfigEntry({ namespace, env: envMap, schema, factory });
  // `schema` lộ ra để test luật của schema mà không cần đặt env.
  return Object.assign(factory, { schema });
}
