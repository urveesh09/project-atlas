import type { CommitDiffResult, DiffEntry } from '@atlas/ingest';
import { compareAscii, compareUtf8, lineageId as deriveLineageId, type Availability, type FileChange, type FileLineage } from '@atlas/schema';

/**
 * Conservative file lineage over a bounded first-parent window (plan §7.3, ADR-007).
 *
 * Changes are processed oldest to newest, including commits between sampled frames:
 * files present at the base get lineages anchored there; `modify` keeps a lineage;
 * `delete` closes it; `add` always starts a new one, even on a reused path; an accepted
 * one-to-one Git rename carries the lineage to its new path. Identical-blob rename
 * candidates are ambiguous: they become delete + add with the new lineage flagged
 * `ambiguous`, never a guessed continuity. Copies are disabled in the diff policy, so a
 * copy is an add. Symlinks and submodules never carry file lineage.
 */

export interface WindowCommit {
  oid: string;
  firstParentOid: string | null;
  committerTime: string;
}

export interface LineageInput {
  repoId: string;
  /** Included commits, newest (selected) first, in first-parent chain order. */
  commits: readonly WindowCommit[];
  /** First-parent diff per included commit; the oldest may be unavailable. */
  diffs: ReadonlyMap<string, CommitDiffResult>;
  /**
   * Files present before the oldest included commit's change. `anchorCommitOid` is the
   * boundary parent when the oldest change is computable, or the oldest commit itself
   * when it is not (its own tree is then the base). Null for a root commit.
   */
  base: { anchorCommitOid: string; paths: readonly string[] } | null;
  /** Path-level scope test shared with the snapshot inventory (validity and exclusions). */
  inScope: (path: string) => boolean;
  /** Commits whose active path -> lineage map should be retained (the frames). */
  retainActiveAt: ReadonlySet<string>;
}

export interface LineageRecord {
  id: string;
  anchorCommitOid: string;
  anchorPath: string;
  continuity: FileLineage['continuity'];
}

export interface ProcessedCommit extends WindowCommit {
  changes: FileChange[];
  changesAvailability: Availability;
  /** Rename detection was skipped by the candidate limit, or the diff fell back to paths. */
  renamesComplete: boolean;
  /**
   * Changes whose line counts are unknown (path-only diff, or one half of a split ambiguous
   * rename). Other null line counts are binary content, where lines do not apply.
   */
  unknownLineChanges: ReadonlySet<FileChange>;
}

export interface LineageResult {
  /** Newest first, matching the input order. */
  commits: ProcessedCommit[];
  lineages: Map<string, LineageRecord>;
  /** Active `path -> lineage` after each retained commit. */
  activeAt: Map<string, Map<string, string>>;
  warnings: { code: string; path: string | null }[];
  renameDetection: Availability;
  lineDiffs: Availability;
}

const REGULAR = new Set(['100644', '100755']);
const isRegular = (mode: string) => REGULAR.has(mode);

type Effect =
  | { kind: 'add'; path: string; entry: DiffEntry; ambiguous: boolean; typeChange: boolean; split?: true }
  | { kind: 'delete'; path: string; entry: DiffEntry; typeChange: boolean; split?: true }
  | { kind: 'modify'; path: string; entry: DiffEntry }
  | { kind: 'rename'; from: string; to: string; entry: DiffEntry };

export function processLineage(input: LineageInput): LineageResult {
  if (input.commits.length === 0) throw new RangeError('A history window has at least one commit');
  const boundaryOid = input.commits.at(-1)!.oid;
  const lineages = new Map<string, LineageRecord>();
  const active = new Map<string, string>();
  const warnings: { code: string; path: string | null }[] = [];
  const warn = (code: string, path: string | null) => {
    if (warnings.length < 1000) warnings.push({ code, path });
  };
  const create = (anchorCommitOid: string, path: string, continuity: FileLineage['continuity']): string => {
    const id = deriveLineageId(input.repoId, boundaryOid, anchorCommitOid, path);
    if (!lineages.has(id)) lineages.set(id, { id, anchorCommitOid, anchorPath: path, continuity });
    return id;
  };

  if (input.base) {
    for (const path of [...input.base.paths].sort(compareUtf8)) {
      if (input.inScope(path)) active.set(path, create(input.base.anchorCommitOid, path, 'exact-path'));
    }
  }

  const processed: ProcessedCommit[] = [];
  const activeAt = new Map<string, Map<string, string>>();
  let renameDetection: Availability = 'complete';
  let lineDiffs: Availability = 'complete';

  for (let index = input.commits.length - 1; index >= 0; index--) {
    const commit = input.commits[index]!;
    const diff = input.diffs.get(commit.oid);
    if (!diff || diff.status === 'unavailable') {
      if (index !== input.commits.length - 1) throw new RangeError('Only the oldest included commit may lack its change');
      processed.push({ ...commit, changes: [], changesAvailability: 'unavailable', renamesComplete: false, unknownLineChanges: new Set() });
      renameDetection = 'partial';
      lineDiffs = 'partial';
      if (input.retainActiveAt.has(commit.oid)) activeAt.set(commit.oid, new Map(active));
      continue;
    }
    const renamesComplete = diff.mode === 'full' && !diff.renameLimited;
    if (!renamesComplete) renameDetection = 'partial';

    const effects = classify(diff.entries, input.inScope, warn);
    const changes: FileChange[] = [];
    const unknownLineChanges = new Set<FileChange>();
    const record = (change: FileChange, unknownLines: boolean) => {
      changes.push(change);
      if (unknownLines) unknownLineChanges.add(change);
    };
    const unknown = (effect: Effect) => diff.mode !== 'full' || ('split' in effect && effect.split === true);

    // Departures first, so a rename chain (a -> b, b -> c) or a rename onto a path deleted
    // in the same commit resolves against the parent state, as Git computed it.
    const departing = new Map<string, string>();
    for (const effect of effects) {
      const from = effect.kind === 'rename' ? effect.from : effect.kind === 'delete' ? effect.path : null;
      if (from === null) continue;
      let id = active.get(from);
      if (id === undefined) {
        warn('HISTORY_LINEAGE_RECOVERED', from);
        id = create(commit.firstParentOid ?? commit.oid, from, 'exact-path');
      }
      departing.set(from, id);
      active.delete(from);
    }
    for (const effect of effects) {
      const e = effect.entry;
      const base = { oldBlobOid: e.oldOid, newBlobOid: e.newOid, added: e.added, deleted: e.deleted };
      switch (effect.kind) {
        case 'delete': {
          const id = departing.get(effect.path)!;
          record({
            ...base,
            kind: effect.typeChange ? 'type-change' : 'delete',
            oldPath: effect.path,
            newPath: effect.typeChange ? effect.path : null,
            newBlobOid: effect.typeChange ? null : e.newOid,
            lineageId: id,
            renameSimilarity: null,
          }, unknown(effect));
          break;
        }
        case 'rename': {
          const id = departing.get(effect.from)!;
          if (active.has(effect.to)) warn('HISTORY_PATH_REUSED', effect.to);
          active.set(effect.to, id);
          const lineage = lineages.get(id)!;
          if (lineage.continuity === 'exact-path') lineage.continuity = 'git-rename';
          record({ ...base, kind: 'rename', oldPath: effect.from, newPath: effect.to, lineageId: id, renameSimilarity: e.similarity }, unknown(effect));
          break;
        }
        case 'modify': {
          let id = active.get(effect.path);
          if (id === undefined) {
            warn('HISTORY_LINEAGE_RECOVERED', effect.path);
            id = create(commit.oid, effect.path, 'exact-path');
            active.set(effect.path, id);
          }
          record({ ...base, kind: 'modify', oldPath: effect.path, newPath: effect.path, lineageId: id, renameSimilarity: null }, unknown(effect));
          break;
        }
        case 'add': {
          if (active.has(effect.path)) warn('HISTORY_PATH_REUSED', effect.path);
          const id = create(commit.oid, effect.path, effect.ambiguous ? 'ambiguous' : 'exact-path');
          active.set(effect.path, id);
          record({
            ...base,
            kind: effect.typeChange ? 'type-change' : 'add',
            oldPath: effect.typeChange ? effect.path : null,
            newPath: effect.path,
            oldBlobOid: effect.typeChange ? null : e.oldOid,
            lineageId: id,
            renameSimilarity: null,
          }, unknown(effect));
          break;
        }
      }
    }
    changes.sort(
      (a, b) =>
        compareUtf8(a.newPath ?? a.oldPath ?? '', b.newPath ?? b.oldPath ?? '') ||
        compareUtf8(a.oldPath ?? '', b.oldPath ?? '') ||
        compareAscii(a.kind, b.kind),
    );
    if (unknownLineChanges.size > 0) lineDiffs = 'partial';
    processed.push({
      ...commit,
      changes,
      changesAvailability: renamesComplete && diff.mode === 'full' ? 'complete' : 'partial',
      renamesComplete,
      unknownLineChanges,
    });
    if (input.retainActiveAt.has(commit.oid)) activeAt.set(commit.oid, new Map(active));
  }
  processed.reverse();
  return { commits: processed, lineages, activeAt, warnings, renameDetection, lineDiffs };
}

/** Turn raw first-parent entries into lineage effects within the analysis scope. */
function classify(entries: readonly DiffEntry[], inScope: (path: string) => boolean, warn: (code: string, path: string | null) => void): Effect[] {
  const effects: Effect[] = [];
  // Identical-blob candidates on each side decide rename ambiguity (plan §7.3 rule 5).
  const leaving = new Map<string, number>();
  const arriving = new Map<string, number>();
  const bump = (map: Map<string, number>, oid: string | null) => {
    if (oid !== null) map.set(oid, (map.get(oid) ?? 0) + 1);
  };
  for (const e of entries) {
    if (e.status === 'D' && isRegular(e.oldMode)) bump(leaving, e.oldOid);
    if (e.status === 'A' && isRegular(e.newMode)) bump(arriving, e.newOid);
    if (e.status === 'R' && isRegular(e.oldMode) && isRegular(e.newMode)) {
      bump(leaving, e.oldOid);
      bump(arriving, e.newOid);
    }
  }
  const scoped = (path: string | null): path is string => path !== null && inScope(path);
  for (const e of entries) {
    if (e.undecodablePath) {
      warn('HISTORY_UNDECODABLE_PATH', null);
      continue;
    }
    switch (e.status) {
      case 'A':
        if (isRegular(e.newMode) && scoped(e.newPath)) effects.push({ kind: 'add', path: e.newPath, entry: e, ambiguous: false, typeChange: false });
        break;
      case 'D':
        if (isRegular(e.oldMode) && scoped(e.oldPath)) effects.push({ kind: 'delete', path: e.oldPath, entry: e, typeChange: false });
        break;
      case 'M':
        if (isRegular(e.oldMode) && isRegular(e.newMode) && scoped(e.newPath)) effects.push({ kind: 'modify', path: e.newPath, entry: e });
        break;
      case 'T': {
        // A file becoming a symlink/submodule ends its occurrence; the reverse begins one.
        if (isRegular(e.oldMode) && !isRegular(e.newMode) && scoped(e.oldPath)) effects.push({ kind: 'delete', path: e.oldPath, entry: e, typeChange: true });
        else if (!isRegular(e.oldMode) && isRegular(e.newMode) && scoped(e.newPath)) effects.push({ kind: 'add', path: e.newPath, entry: e, ambiguous: false, typeChange: true });
        break;
      }
      case 'R': {
        const fromOk = isRegular(e.oldMode) && scoped(e.oldPath);
        const toOk = isRegular(e.newMode) && scoped(e.newPath);
        const ambiguous = (leaving.get(e.oldOid ?? '') ?? 0) > 1 || (arriving.get(e.newOid ?? '') ?? 0) > 1;
        const split = { ...e, added: null, deleted: null };
        if (fromOk && toOk && !ambiguous) effects.push({ kind: 'rename', from: e.oldPath!, to: e.newPath!, entry: e });
        else {
          // Git's numstat describes the pair (old -> new); neither half alone has known
          // per-file line counts, including a rename across the analysis scope boundary.
          if (fromOk) effects.push({ kind: 'delete', path: e.oldPath!, entry: split, typeChange: false, split: true });
          if (toOk) effects.push({ kind: 'add', path: e.newPath!, entry: split, ambiguous: ambiguous && fromOk, typeChange: false, split: true });
        }
        break;
      }
      default:
        // Copies are disabled by policy; unmerged/unknown entries cannot occur in commits.
        warn('HISTORY_UNSUPPORTED_CHANGE', e.newPath ?? e.oldPath);
    }
  }
  return effects;
}
