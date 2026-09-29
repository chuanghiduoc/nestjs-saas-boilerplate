import type { Billing } from '../../modules/billing/index.js';

export abstract class ModuleReader {
  abstract read(): Promise<Billing>;
}
