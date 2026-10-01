import { owner } from '../flags/ok.js';

export const leaked = owner;
export abstract class LeakyReader {
  abstract read(): Promise<string>;
}
