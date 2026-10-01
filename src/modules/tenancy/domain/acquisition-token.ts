import { createHash, randomBytes } from 'node:crypto';
import { INVITE_TOKEN_BYTES } from '../constants.js';

export type AcquisitionToken = { token: string; hashHex: string };

/** Spec SP3 §9.1: chỉ SHA-256 được lưu; hex để đi qua `Db.execute` rồi `decode(?, 'hex')` trong SQL. */
export const tokenHashHex = (token: string): string =>
  createHash('sha256').update(token, 'utf8').digest('hex');

export function newAcquisitionToken(): AcquisitionToken {
  const token = randomBytes(INVITE_TOKEN_BYTES).toString('base64url');
  return { token, hashHex: tokenHashHex(token) };
}

/** Token ở fragment URL: không vào log server, không vào `Referer` của frontend (spec §9.1). */
export const tokenUrl = (base: string, token: string): string =>
  `${base}#token=${token}`;
