import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { type ErrorCode } from '@atlas/schema';

export class ServiceError extends Error {
  constructor(readonly code: ErrorCode, readonly status: number, message: string, readonly retryAfter?: number) {
    super(message);
  }
}
export const opaqueId = (prefix: 'job' | 'req') => `${prefix}_${randomBytes(16).toString('hex')}`;
export const newToken = () => randomBytes(32).toString('base64url');
export const tokenHash = (token: string, domain: 'session' | 'management') => createHash('sha256').update(`${domain}\0${token}`).digest('hex');
export function tokenMatches(token: string, storedHash: string): boolean {
  const actual = Buffer.from(tokenHash(token, 'management'), 'hex');
  const expected = Buffer.from(storedHash, 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
/** Daily client bucket: raw IP never enters durable state or default logs. */
export function clientBucket(address: string, secret: string, now: Date): string {
  return createHmac('sha256', secret).update(`${now.toISOString().slice(0, 10)}\0${address}`).digest('hex');
}
export const terminal = (state: string) => ['READY', 'PARTIAL', 'FAILED', 'CANCELLED'].includes(state);
