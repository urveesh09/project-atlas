import { describe, expect, it } from 'vitest';
import type { CommitDiffResult, DiffEntry } from '@atlas/ingest';
import { lineageId } from '@atlas/schema';
import { churnAvailability, churnByFrame, coChangePairs, processLineage, selectFrameIndices, type ProcessedCommit, type WindowCommit } from '@atlas/history';

/**
 * Pure history semantics with hand-written expectations (plan §7.2–7.5). Each case names
 * the rule it pins; nothing here is derived by running the implementation first.
 */
const REPO = 'repo_' + '1'.repeat(64);
const oid = (n: number) => n.toString(16).padStart(40, '0');
const blob = (n: number) => 'b'.repeat(32) + n.toString(16).padStart(8, '0');
const time = (day: number) => new Date(Date.UTC(2026, 8, day)).toISOString();

/** Commits given oldest first for readability; the API takes newest first. */
function chain(count: number): WindowCommit[] {
  return Array.from({ length: count }, (_, i) => ({ oid: oid(i + 1), firstParentOid: i === 0 ? null : oid(i), committerTime: time(i + 1) })).reverse();
}

const add = (path: string, b: number, lines = 10): DiffEntry => ({ status: 'A', similarity: null, oldMode: '000000', newMode: '100644', oldOid: null, newOid: blob(b), oldPath: null, newPath: path, added: lines, deleted: 0, undecodablePath: false });
const modify = (path: string, from: number, to: number, a = 1, d = 1): DiffEntry => ({ status: 'M', similarity: null, oldMode: '100644', newMode: '100644', oldOid: blob(from), newOid: blob(to), oldPath: path, newPath: path, added: a, deleted: d, undecodablePath: false });
const del = (path: string, b: number, lines = 10): DiffEntry => ({ status: 'D', similarity: null, oldMode: '100644', newMode: '000000', oldOid: blob(b), newOid: null, oldPath: path, newPath: null, added: 0, deleted: lines, undecodablePath: false });
const rename = (from: string, to: string, b1: number, b2: number, similarity = 100, a = 0, d = 0): DiffEntry => ({ status: 'R', similarity, oldMode: '100644', newMode: '100644', oldOid: blob(b1), newOid: blob(b2), oldPath: from, newPath: to, added: a, deleted: d, undecodablePath: false });
const full = (...entries: DiffEntry[]): Extract<CommitDiffResult, { mode: string }> => ({ status: 'complete', mode: 'full', renameLimited: false, entries });

function run(commits: WindowCommit[], diffs: CommitDiffResult[], options: { base?: { anchor: number; paths: string[] } | null; frames?: number[]; inScope?: (p: string) => boolean } = {}) {
  const oldestFirst = [...commits].reverse();
  return processLineage({
    repoId: REPO,
    commits,
    diffs: new Map(oldestFirst.map((c, i) => [c.oid, diffs[i]!] as const).filter(([, d]) => d !== undefined)),
    base: options.base === undefined || options.base === null ? null : { anchorCommitOid: oid(options.base.anchor), paths: options.base.paths },
    inScope: options.inScope ?? (() => true),
    retainActiveAt: new Set((options.frames ?? oldestFirst.map((_, i) => i + 1)).map(oid)),
  });
}

describe('frame selection (plan §7.2)', () => {
  it('selects floor(i(n-1)/(k-1)) in oldest-to-newest order, always ending at HEAD', () => {
    expect(selectFrameIndices(200, 12)).toEqual([0, 18, 36, 54, 72, 90, 108, 126, 144, 162, 180, 199]);
    expect(selectFrameIndices(12, 12)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(selectFrameIndices(5, 12)).toEqual([0, 1, 2, 3, 4]);
    expect(selectFrameIndices(10, 4)).toEqual([0, 3, 6, 9]);
    expect(selectFrameIndices(7, 2)).toEqual([0, 6]);
  });
  it('k = 1 selects HEAD alone; a single-commit window selects it', () => {
    expect(selectFrameIndices(50, 1)).toEqual([49]);
    expect(selectFrameIndices(1, 12)).toEqual([0]);
  });
  it('rejects empty windows and zero requests', () => {
    expect(() => selectFrameIndices(0, 3)).toThrow(RangeError);
    expect(() => selectFrameIndices(3, 0)).toThrow(RangeError);
  });
});

describe('lineage (plan §7.3)', () => {
  it('root window: adds create lineages anchored at their commit; modify keeps them', () => {
    const commits = chain(2);
    const result = run(commits, [full(add('a.ts', 1)), full(modify('a.ts', 1, 2))]);
    const a = lineageId(REPO, oid(1), oid(1), 'a.ts');
    expect([...result.lineages.keys()]).toEqual([a]);
    expect(result.activeAt.get(oid(2))).toEqual(new Map([['a.ts', a]]));
    expect(result.commits.map((c) => c.changes.map((x) => [x.kind, x.lineageId]))).toEqual([[['modify', a]], [['add', a]]]);
  });

  it('files present at the base anchor at the boundary parent; the boundary is the oldest included commit', () => {
    const commits = chain(3).slice(0, 2); // window: commits 3 and 2; commit 1 is the boundary parent
    const result = run(commits, [full(modify('a.ts', 1, 2)), full()], { base: { anchor: 1, paths: ['a.ts', 'b.ts'] }, frames: [2, 3] });
    expect(result.activeAt.get(oid(3))!.get('a.ts')).toBe(lineageId(REPO, oid(2), oid(1), 'a.ts'));
    expect(result.activeAt.get(oid(3))!.get('b.ts')).toBe(lineageId(REPO, oid(2), oid(1), 'b.ts'));
  });

  it('pure rename keeps the lineage; rename+edit is still one lineage; both are git-rename', () => {
    const commits = chain(3);
    const result = run(commits, [full(add('old.ts', 1), add('x.ts', 5)), full(rename('old.ts', 'new.ts', 1, 1)), full(rename('x.ts', 'y.ts', 5, 6, 86, 2, 1))]);
    const old = lineageId(REPO, oid(1), oid(1), 'old.ts');
    const x = lineageId(REPO, oid(1), oid(1), 'x.ts');
    expect(result.activeAt.get(oid(3))).toEqual(new Map([['new.ts', old], ['y.ts', x]]));
    expect(result.lineages.get(old)!.continuity).toBe('git-rename');
    expect(result.lineages.get(x)!.continuity).toBe('git-rename');
    const renameChange = result.commits[0]!.changes[0]!;
    expect(renameChange).toMatchObject({ kind: 'rename', oldPath: 'x.ts', newPath: 'y.ts', renameSimilarity: 86, added: 2, deleted: 1, lineageId: x });
  });

  it('delete then re-add of the same path starts a new lineage', () => {
    const commits = chain(3);
    const result = run(commits, [full(add('a.ts', 1)), full(del('a.ts', 1)), full(add('a.ts', 2))]);
    const first = lineageId(REPO, oid(1), oid(1), 'a.ts');
    const second = lineageId(REPO, oid(1), oid(3), 'a.ts');
    expect(first).not.toBe(second);
    expect(result.activeAt.get(oid(2))!.size).toBe(0);
    expect(result.activeAt.get(oid(3))!.get('a.ts')).toBe(second);
  });

  it('identical-blob rename candidates are ambiguous: delete + add, continuity never invented', () => {
    const commits = chain(2);
    // Two identical files deleted; Git pairs one of them with the identical added file.
    const result = run(commits, [full(add('a.ts', 7), add('b.ts', 7)), full(rename('a.ts', 'c.ts', 7, 7), del('b.ts', 7))]);
    const a = lineageId(REPO, oid(1), oid(1), 'a.ts');
    const c = lineageId(REPO, oid(1), oid(2), 'c.ts');
    expect(result.activeAt.get(oid(2))).toEqual(new Map([['c.ts', c]]));
    expect(result.lineages.get(c)!.continuity).toBe('ambiguous');
    expect(result.lineages.get(a)!.continuity).toBe('exact-path');
    const kinds = result.commits[0]!.changes.map((x) => `${x.kind}:${x.oldPath ?? x.newPath}`);
    expect(kinds).toEqual(['delete:a.ts', 'delete:b.ts', 'add:c.ts']);
    // The halves of a declined rename have unknown per-file line counts.
    expect(result.commits[0]!.unknownLineChanges.size).toBe(2);
    expect(result.lineDiffs).toBe('partial');
  });

  it('one file becoming two identical copies is ambiguous as well', () => {
    const commits = chain(2);
    const result = run(commits, [full(add('a.ts', 3)), full(rename('a.ts', 'b.ts', 3, 3), add('c.ts', 3))]);
    expect(result.lineages.get(lineageId(REPO, oid(1), oid(2), 'b.ts'))!.continuity).toBe('ambiguous');
  });

  it('a rename chain inside one commit resolves against the parent state', () => {
    const commits = chain(2);
    const result = run(commits, [full(add('a.ts', 1), add('b.ts', 2)), full(rename('a.ts', 'b.ts', 1, 1), rename('b.ts', 'c.ts', 2, 2))]);
    expect(result.activeAt.get(oid(2))).toEqual(
      new Map([
        ['b.ts', lineageId(REPO, oid(1), oid(1), 'a.ts')],
        ['c.ts', lineageId(REPO, oid(1), oid(1), 'b.ts')],
      ]),
    );
    expect(result.warnings).toEqual([]);
  });

  it('scope: renames across the boundary become add or delete; symlinks and submodules carry no lineage', () => {
    const commits = chain(2);
    const inScope = (p: string) => !p.startsWith('vendor/');
    const symlink: DiffEntry = { ...add('link', 9), newMode: '120000' };
    const toSymlink: DiffEntry = { status: 'T', similarity: null, oldMode: '100644', newMode: '120000', oldOid: blob(4), newOid: blob(5), oldPath: 'f.ts', newPath: 'f.ts', added: null, deleted: null, undecodablePath: false };
    const result = run(commits, [full(add('vendor/x.js', 1), add('f.ts', 4)), full(rename('vendor/x.js', 'src/x.js', 1, 1), symlink, toSymlink)], { inScope });
    const changes = result.commits[0]!.changes.map((x) => `${x.kind}:${x.oldPath}->${x.newPath}`);
    expect(changes).toEqual(['type-change:f.ts->f.ts', 'add:null->src/x.js']);
    expect(result.activeAt.get(oid(2))).toEqual(new Map([['src/x.js', lineageId(REPO, oid(1), oid(2), 'src/x.js')]]));
  });

  it('an unavailable oldest change leaves the base at that commit and marks coverage partial', () => {
    const commits = chain(2);
    const result = run(commits, [undefined as never, full(modify('a.ts', 1, 2))], { base: { anchor: 1, paths: ['a.ts'] } });
    expect(result.commits.at(-1)!.changesAvailability).toBe('unavailable');
    expect(result.activeAt.get(oid(2))!.get('a.ts')).toBe(lineageId(REPO, oid(1), oid(1), 'a.ts'));
    expect(result.renameDetection).toBe('partial');
    expect(result.lineDiffs).toBe('partial');
  });

  it('only the oldest commit may lack its change', () => {
    const commits = chain(3);
    expect(() => run(commits, [full(add('a.ts', 1)), undefined as never, full()])).toThrow(RangeError);
  });

  it('path-only diffs and limited rename detection are partial; binary line counts are not', () => {
    const commits = chain(3);
    const binary: DiffEntry = { ...add('img.png', 3), added: null, deleted: null };
    const pathsOnly: CommitDiffResult = { status: 'partial', mode: 'paths-only', renameLimited: false, entries: [{ ...modify('a.ts', 1, 2), added: null, deleted: null }] };
    const binaryOnly = run(chain(1), [full(binary)]);
    expect(binaryOnly.lineDiffs).toBe('complete');
    expect(binaryOnly.commits[0]!.changesAvailability).toBe('complete');
    const result = run(commits, [full(add('a.ts', 1)), pathsOnly, { ...full(modify('a.ts', 2, 3)), status: 'partial', renameLimited: true }]);
    expect(result.commits.map((c) => c.changesAvailability)).toEqual(['partial', 'partial', 'complete']);
    expect(result.renameDetection).toBe('partial');
    expect(result.lineDiffs).toBe('partial');
  });
});

describe('churn (plan §7.5): no later-commit leakage', () => {
  const commits = chain(4);
  const lineage = processLineage({
    repoId: REPO,
    commits,
    diffs: new Map([
      [oid(1), full(add('a.ts', 1, 10), { ...add('img.png', 9), added: null, deleted: null })],
      [oid(2), full(modify('a.ts', 1, 2, 3, 1))],
      [oid(3), full(modify('a.ts', 2, 3, 5, 2), { ...modify('img.png', 9, 10), added: null, deleted: null })],
      [oid(4), full(modify('a.ts', 3, 4, 1, 1))],
    ]),
    base: null,
    inScope: () => true,
    retainActiveAt: new Set([oid(2), oid(4)]),
  });
  const a = lineageId(REPO, oid(1), oid(1), 'a.ts');
  const img = lineageId(REPO, oid(1), oid(1), 'img.png');
  const churn = churnByFrame(lineage.commits, new Set([oid(2), oid(4)]));

  it('an earlier frame counts only commits up to and including itself', () => {
    expect(churn.get(oid(2))!.byLineage.get(a)).toMatchObject({ changedCommits: 2, linesAdded: 13, linesDeleted: 1 });
    expect(churn.get(oid(2))!.commitsInScope).toBe(2);
    expect(churn.get(oid(4))!.byLineage.get(a)).toMatchObject({ changedCommits: 4, linesAdded: 19, linesDeleted: 4 });
  });

  it('binary changes count as commits, never as zero-line text changes', () => {
    const imgChurn = churn.get(oid(4))!.byLineage.get(img)!;
    expect(imgChurn).toMatchObject({ changedCommits: 2, linesKnown: 0, linesNotApplicable: 2, linesUnknown: 0 });
    expect(churnAvailability(churn.get(oid(4))!, imgChurn)).toBe('complete');
  });
});

describe('co-change (plan §6.4)', () => {
  const ids = ['lin_' + 'a'.repeat(64), 'lin_' + 'b'.repeat(64), 'lin_' + 'c'.repeat(64)];
  const commit = (n: number, lineages: string[], availability: ProcessedCommit['changesAvailability'] = 'complete'): ProcessedCommit => ({
    oid: oid(n),
    firstParentOid: null,
    committerTime: time(n),
    changesAvailability: availability,
    renamesComplete: true,
    unknownLineChanges: new Set(),
    changes: lineages.map((l) => ({ kind: 'modify', oldPath: l, newPath: l, oldBlobOid: null, newBlobOid: null, lineageId: l, renameSimilarity: null, added: 1, deleted: 1 })),
  });

  it('pairs need 3 shared commits; union and jaccard are exact', () => {
    const commits = [commit(1, [ids[0]!, ids[1]!]), commit(2, [ids[0]!, ids[1]!]), commit(3, [ids[0]!, ids[1]!, ids[2]!]), commit(4, [ids[0]!]), commit(5, [ids[1]!, ids[2]!])];
    const result = coChangePairs(commits, () => true);
    expect(result.pairs).toEqual([{ aLineageId: ids[0], bLineageId: ids[1], togetherCommits: 3, eligibleUnionCommits: 5, jaccard: 3 / 5 }]);
    expect(result.availability).toBe('complete');
  });

  it('commits touching more than 50 lineages are excluded from pairs', () => {
    const many = Array.from({ length: 51 }, (_, i) => 'lin_' + i.toString(16).padStart(64, '0'));
    const result = coChangePairs([commit(1, many), commit(2, many), commit(3, many)], () => true);
    expect(result.pairs).toEqual([]);
    expect(result.excludedCommits).toBe(3);
  });

  it('an unavailable change makes co-change partial', () => {
    expect(coChangePairs([commit(1, [], 'unavailable')], () => true).availability).toBe('partial');
  });
  it('labels useful pairs partial when rename continuity is uncertain', () => {
    const changes = [commit(1, [ids[0]!, ids[1]!]), commit(2, [ids[0]!, ids[1]!]), commit(3, [ids[0]!, ids[1]!], 'partial')];
    changes[2]!.renamesComplete = false;
    const result = coChangePairs(changes, () => true);
    expect(result.pairs).toEqual([{ aLineageId: ids[0], bLineageId: ids[1], togetherCommits: 3, eligibleUnionCommits: 3, jaccard: 1 }]);
    expect(result.availability).toBe('partial');
  });
});
