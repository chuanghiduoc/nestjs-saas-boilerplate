import type { ConfigFactory } from '@nestjs/config';
import type { z } from 'zod';

export type ConfigEntry = {
  namespace: string;
  env: Record<string, string>;
  schema: z.ZodObject;
  factory?: ConfigFactory;
};
export type ProductionRule = {
  name: string;
  rule: (
    cfg: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
  ) => string | undefined;
};

const entries = new Map<string, ConfigEntry>();
const productionRules: ProductionRule[] = [];
const crossRules: ProductionRule[] = [];

export function registerConfigEntry(entry: ConfigEntry): void {
  if (entries.has(entry.namespace))
    throw new Error(`Config namespace "${entry.namespace}" already registered`);
  entries.set(entry.namespace, entry);
}
export const configRegistry = (): readonly ConfigEntry[] => [
  ...entries.values(),
];
export const configFactories = (): ConfigFactory[] =>
  [...entries.values()].flatMap((e) => (e.factory ? [e.factory] : []));

export function defineProductionRule(
  name: string,
  rule: ProductionRule['rule'],
): void {
  if (productionRules.some((r) => r.name === name))
    throw new Error(`Production rule "${name}" already defined`);
  productionRules.push({ name, rule });
}
export const productionRuleRegistry = (): readonly ProductionRule[] => [
  ...productionRules,
];

/**
 * Luật ràng buộc giữa nhiều namespace, áp dụng ở MỌI môi trường (khác `defineProductionRule`):
 * dùng cho bất biến mà vi phạm là lỗi đúng/sai chứ không phải chính sách production.
 */
export function defineConfigRule(
  name: string,
  rule: ProductionRule['rule'],
): void {
  if (crossRules.some((r) => r.name === name))
    throw new Error(`Config rule "${name}" already defined`);
  crossRules.push({ name, rule });
}
export const configRuleRegistry = (): readonly ProductionRule[] => [
  ...crossRules,
];
