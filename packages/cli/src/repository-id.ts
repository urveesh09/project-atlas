import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { localRepositoryId } from '@atlas/schema';

/**
 * Local repository identity (plan §7.1): a generated UUID persisted beside the artifact in
 * `repository-id.json`, never derived from a machine path. Reusing it keeps snapshot and
 * node IDs stable across runs; a fresh UUID intentionally makes a fresh identity.
 */
export const REPOSITORY_ID_FILE = 'repository-id.json';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface RepositoryIdentity {
  format: 'atlas.repository-id/1';
  uuid: string;
  repoId: string;
}

export function identityFromUuid(uuid: string): RepositoryIdentity {
  if (!UUID.test(uuid)) throw new Error('A repository ID must be a lowercase UUID');
  return { format: 'atlas.repository-id/1', uuid, repoId: localRepositoryId(uuid) };
}

export function newIdentity(): RepositoryIdentity {
  return identityFromUuid(randomUUID());
}

export async function readIdentity(artifactDir: string): Promise<RepositoryIdentity | null> {
  try {
    const value = JSON.parse(await readFile(path.join(artifactDir, REPOSITORY_ID_FILE), 'utf8')) as Partial<RepositoryIdentity>;
    if (value.format !== 'atlas.repository-id/1' || typeof value.uuid !== 'string') return null;
    const identity = identityFromUuid(value.uuid);
    return identity.repoId === value.repoId ? identity : null;
  } catch {
    return null;
  }
}
