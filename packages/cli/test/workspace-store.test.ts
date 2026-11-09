import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, symlink, link, chmod } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { canonicalJson } from '@atlas/schema';
import { createReviewWorkspace, decideReviewWorkspace, reviewArchitecture } from '@atlas/graph';
import { initializeWorkspace, loadWorkspace, updateWorkspace, readWorkspaceFile, exportWorkspace } from '../src/workspace-store.js';
import { architectureAnalysis, architectureFixture } from '../../graph/test/architecture-fixture.js';

vi.mock('node:fs/promises', { spy: true });

let root: string, directory: string, artifact: string, tempBase: string;
function initial() {
  return createReviewWorkspace(reviewArchitecture(architectureAnalysis,
    architectureFixture('a', ['src/a.ts', 'tests/a.ts'], [[0, 1]], { roles: ['source', 'test'] }),
    { format: 'atlas.architecture-policy/1', rules: [{ id: 'tests', kind: 'forbidden-dependency', from: { roles: ['source'] }, to: { roles: ['test'] }, edgeKinds: ['imports-value'] }] }));
}
beforeEach(async () => {
  tempBase = await fs.realpath(os.tmpdir());
  root = await mkdtemp(path.join(tempBase, 'atlas-local-store-'));
  directory = path.join(root, 'workspace'); artifact = path.join(root, 'artifact');
  await mkdir(artifact, { mode: 0o700 });
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (path.dirname(root) !== tempBase || !path.basename(root).startsWith('atlas-local-store-')) throw new Error('Unexpected cleanup target');
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

it('initializes privately, atomically updates and exports without replacing any prior output', async () => {
  const workspace = initial(); await initializeWorkspace(directory, artifact, workspace);
  const prior = await readFile(path.join(directory, 'workspace.json'), 'utf8');
  await expect(initializeWorkspace(directory, artifact, workspace)).rejects.toThrow();
  expect(await readFile(path.join(directory, 'workspace.json'), 'utf8')).toBe(prior);
  const next = await updateWorkspace(directory, 0, async current => decideReviewWorkspace(current, 0, current.report.rows[0]!.id, 'acknowledged', 'maintainers'));
  expect(await loadWorkspace(directory)).toEqual(next);
  expect(next.revision).toBe(1);
  const output = path.join(root, 'export.json');
  await exportWorkspace(directory, artifact, output, next);
  expect(await readFile(output, 'utf8')).toBe(canonicalJson(next) + '\n');
  await expect(exportWorkspace(directory, artifact, output, workspace)).rejects.toThrow();
  await expect(exportWorkspace(directory, artifact, path.join(directory, 'extra.json'), next)).rejects.toThrow(/outside/);
  expect(await readdir(directory)).toEqual(['workspace.json']);
});

it('allows one cooperative writer and rejects busy/stale writes without losing a decision', async () => {
  await initializeWorkspace(directory, artifact, initial());
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const first = updateWorkspace(directory, 0, async current => { enter(); await barrier; return decideReviewWorkspace(current, 0, current.report.rows[0]!.id, 'deferred', 'unassigned'); });
  await entered;
  await expect(updateWorkspace(directory, 0, async current => current)).rejects.toThrow(/lock/);
  release(); await first;
  const bytes = await readFile(path.join(directory, 'workspace.json'), 'utf8');
  await expect(updateWorkspace(directory, 0, async current => current)).rejects.toThrow(/revision/);
  expect(await readFile(path.join(directory, 'workspace.json'), 'utf8')).toBe(bytes);
  expect((await loadWorkspace(directory)).decisions[0]?.state).toBe('deferred');
  expect(await readdir(directory)).toEqual(['workspace.json']);
});

it('keeps previous state and cleans owned temporary/lock files on precommit write or validation failure', async () => {
  await initializeWorkspace(directory, artifact, initial());
  const state = path.join(directory, 'workspace.json'), before = await readFile(state, 'utf8');
  await expect(updateWorkspace(directory, 0, async () => { throw new Error('authored validator failure'); })).rejects.toThrow();
  vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('authored atomic rename failure'));
  await expect(updateWorkspace(directory, 0, async current => decideReviewWorkspace(current, 0, current.report.rows[0]!.id, 'deferred', 'maintainers'))).rejects.toThrow(/rename/);
  expect(await readFile(state, 'utf8')).toBe(before);
  expect(await readdir(directory)).toEqual(['workspace.json']);
});

it('detects noncooperating byte replacement and cancellation before commit', async () => {
  await initializeWorkspace(directory, artifact, initial());
  const state = path.join(directory, 'workspace.json'), before = await readFile(state, 'utf8'), outsideEdit = before + ' ';
  await expect(updateWorkspace(directory, 0, async current => {
    await writeFile(state, outsideEdit);
    return decideReviewWorkspace(current, 0, current.report.rows[0]!.id, 'deferred', 'maintainers');
  })).rejects.toThrow(/changed outside/);
  expect(await readFile(state, 'utf8')).toBe(outsideEdit);
  const abort = new AbortController();
  await expect(updateWorkspace(directory, 0, async current => {
    abort.abort(); return decideReviewWorkspace(current, 0, current.report.rows[0]!.id, 'deferred', 'maintainers');
  }, abort.signal)).rejects.toThrow(/cancelled/);
  expect(await readFile(state, 'utf8')).toBe(outsideEdit);
  expect(await readdir(directory)).toEqual(['workspace.json']);
});

it('refuses artifact-relative workspaces, path aliases, hard-linked or nonregular state', async () => {
  await expect(initializeWorkspace(path.join(artifact, 'workspace'), artifact, initial())).rejects.toThrow(/outside/);
  await initializeWorkspace(directory, artifact, initial());
  const alias = path.join(root, 'alias');
  await symlink(directory, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await expect(loadWorkspace(alias)).rejects.toThrow(/symlinks|junctions/);
  const state = path.join(directory, 'workspace.json');
  await link(state, path.join(root, 'hardlink.json'));
  await expect(readWorkspaceFile(state, true)).rejects.toThrow(/regular/);
  await expect(readWorkspaceFile(directory)).rejects.toThrow(/regular/);
});

it('refuses case aliases of protected directories on case-insensitive filesystems', async ({ skip }) => {
  const alias = path.join(root, 'ARTIFACT');
  if (!await fs.lstat(alias).catch(() => null)) return skip();
  await expect(initializeWorkspace(path.join(alias, 'nested'), artifact, initial())).rejects.toThrow(/outside/);
  expect(await readdir(artifact)).toEqual([]);
});

it.skipIf(process.platform !== 'win32')('refuses alternate streams on protected artifact directories', async () => {
  const workspace = initial();
  await initializeWorkspace(directory, artifact, workspace);
  const stream = `${artifact}:atlas-review`;
  await expect(exportWorkspace(directory, artifact, stream, workspace)).rejects.toThrow(/alternate data stream/);
  await expect(readWorkspaceFile(stream)).rejects.toThrow(/alternate data stream/);
  expect(await readdir(artifact)).toEqual([]);
});

it.skipIf(process.platform === 'win32')('refuses permissive private state and file symlinks', async () => {
  await initializeWorkspace(directory, artifact, initial());
  const state = path.join(directory, 'workspace.json');
  await chmod(state, 0o644);
  await expect(loadWorkspace(directory)).rejects.toThrow(/permissions/);
  await chmod(state, 0o600);
  await symlink(state, path.join(root, 'state-alias.json'));
  await expect(readWorkspaceFile(path.join(root, 'state-alias.json'))).rejects.toThrow(/regular/);
});
