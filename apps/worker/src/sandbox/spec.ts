import { z } from 'zod';
import { GitOidSchema, LIMITS } from '@atlas/schema';

/**
 * Sandbox job specifications. The coordinator builds them from validated, database-held
 * identity only (numeric repository ID, canonical owner/name, full commit ID); nothing
 * here is a submitted string. Sandboxes parse them strictly before doing anything.
 */
const AbsolutePath = z.string().min(1).max(1024).refine((p) => (p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p)) && !p.includes('\0') && !p.split(/[\\/]/).includes('..'), 'absolute path');
const Owner = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/);
const Name = z.string().regex(/^[A-Za-z0-9._-]{1,100}$/);

export const AnalyzeSpecSchema = z.strictObject({
  v: z.literal(1),
  objects: AbsolutePath,
  scratch: AbsolutePath,
  commitOid: GitOidSchema,
  objectFormat: z.enum(['sha1', 'sha256']),
  repository: z.strictObject({
    numericId: z.string().regex(/^[1-9]\d{0,19}$/),
    owner: Owner,
    name: Name,
  }),
  history: z.boolean(),
  /** History requested but not yet acquired: produce the HEAD checkpoint. */
  checkpoint: z.boolean(),
  deadlineMs: z.number().int().min(1000).max(LIMITS.workerDeadlineMs),
});
export type AnalyzeSpec = z.infer<typeof AnalyzeSpecSchema>;

export const AcquireSpecSchema = z.strictObject({
  v: z.literal(1),
  target: AbsolutePath,
  owner: Owner,
  name: Name,
  commitOid: GitOidSchema,
  depth: z.number().int().min(1).max(LIMITS.firstParentCommits + 1),
  maxBytes: z.number().int().min(1).max(LIMITS.acquisitionNetworkBytes),
  timeoutMs: z.number().int().min(1000).max(LIMITS.workerDeadlineMs),
  source: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('github'), proxy: z.string().regex(/^http:\/\/[a-z0-9][a-z0-9.-]{0,252}:\d{1,5}$/).nullable() }),
    z.strictObject({ kind: z.literal('fixture'), remote: AbsolutePath }),
  ]),
});
export type AcquireSpec = z.infer<typeof AcquireSpecSchema>;

export const BrokerSpecSchema = z.strictObject({
  v: z.literal(1),
  port: z.number().int().min(1024).max(65535),
  maxBytes: z.number().int().min(1).max(LIMITS.acquisitionNetworkBytes),
});
export type BrokerSpec = z.infer<typeof BrokerSpecSchema>;

/** The scratch-relative location of the acquired bare repository's object store. */
export const ACQUIRED_GIT_DIR = 'git';
export const ACQUIRED_OBJECTS = 'git/meta.git/objects';

export const AnalyzeResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), status: z.enum(['complete', 'partial']) }),
  z.strictObject({ ok: z.literal(false), code: z.string().regex(/^[A-Z_]{1,64}$/), limit: z.string().regex(/^[A-Z_]{1,64}$/).nullable() }),
]);
export const AcquireResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), bytesOnDisk: z.number().int().min(0) }),
  z.strictObject({ ok: z.literal(false), code: z.string().regex(/^[A-Z_]{1,64}$/) }),
]);
export const BrokerResultSchema = z.strictObject({
  ok: z.literal(true),
  bytes: z.number().int().min(0),
  exceeded: z.boolean(),
  tunnels: z.number().int().min(0),
  refused: z.number().int().min(0),
});
export const ProgressSchema = z.strictObject({
  stage: z.enum(['resolve', 'history', 'enumerate', 'inventory', 'hierarchy', 'parse', 'dependencies', 'findings', 'frames', 'layout', 'assemble', 'ready']),
  done: z.number().int().min(0).max(1_000_000).optional(),
  total: z.number().int().min(0).max(1_000_000).optional(),
});
export type SandboxProgress = z.infer<typeof ProgressSchema>;
