import type { owner } from '../flags/ok.js';

export abstract class TypedReader {
  abstract read(): Promise<typeof owner>;
}
