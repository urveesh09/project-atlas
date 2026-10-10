import { batchCheck, listTree, openLocalRepository, readCommit, readObjects, type SafeGit } from '@atlas/ingest';
import { LIMITS, type ArtifactBundle } from '@atlas/schema';

/**
 * Read-only source attachment for `atlas serve --repo` (plan §14.3). The repository is
 * attached only if every analyzed frame's commit, first-parent link and every file's
 * path/blob pair match the attached repository's committed trees. Requests name a
 * snapshot ID and a file occurrence ID — never a path, revision or object ID — and are
 * mapped to the validated blob. Opaque, oversized or non-UTF-8 content is unavailable.
 */
export type SourceStatus =
  | { attached: true }
  | { attached: false; reason: 'NOT_REQUESTED' | 'NOT_A_REPOSITORY' | 'COMMIT_NOT_FOUND' | 'FIRST_PARENT_MISMATCH' | 'TREE_MISMATCH' | 'OBJECT_FORMAT_MISMATCH' };

export type SourceResult =
  | { ok: true; path: string; text: string; lineCount: number }
  | { ok: false; status: 403 | 404 | 409 | 413; reason: string };

export class SourceAttachment {
  private constructor(
    readonly status: SourceStatus,
    private readonly git: SafeGit | null,
    /** snapshotId -> nodeId -> validated file facts. */
    private readonly files: Map<string, Map<string, { path: string; blobOid: string; supported: boolean }>>,
  ) {}

  static none(reason: Extract<SourceStatus, { attached: false }>['reason'] = 'NOT_REQUESTED'): SourceAttachment {
    return new SourceAttachment({ attached: false, reason }, null, new Map());
  }

  static async attach(repoPath: string, bundle: ArtifactBundle): Promise<SourceAttachment> {
    let opened;
    try {
      opened = await openLocalRepository(repoPath);
    } catch {
      return SourceAttachment.none('NOT_A_REPOSITORY');
    }
    const { repo, git } = opened;
    const fail = async (reason: Extract<SourceStatus, { attached: false }>['reason']) => {
      await git.dispose();
      return SourceAttachment.none(reason);
    };
    if (repo.objectFormat !== bundle.manifest.repo.objectFormat) return fail('OBJECT_FORMAT_MISMATCH');
    const files = new Map<string, Map<string, { path: string; blobOid: string; supported: boolean }>>();
    for (let i = 0; i < bundle.manifest.frames.length; i++) {
      const frame = bundle.manifest.frames[i]!;
      const [info] = await batchCheck(git, [frame.commit.oid]).catch(() => [undefined]);
      if (!info || info.type !== 'commit') return fail('COMMIT_NOT_FOUND');
      const commit = await readCommit(git, frame.commit.oid);
      if ((commit.parents[0] ?? null) !== frame.commit.firstParentOid) return fail('FIRST_PARENT_MISMATCH');
      const tree = await listTree(git, commit.tree, { maxEntries: LIMITS.treeEntriesPerSnapshot });
      const committed = new Map(tree.entries.filter((e) => e.path !== null).map((e) => [e.path!, e.oid]));
      const graph = bundle.graphs[i]!;
      const map = new Map<string, { path: string; blobOid: string; supported: boolean }>();
      for (const node of graph.nodes) {
        if (node.kind !== 'file') continue;
        if (committed.get(node.path) !== node.blobOid) return fail('TREE_MISMATCH');
        map.set(node.id, { path: node.path, blobOid: node.blobOid, supported: node.language !== null && node.byteSize <= LIMITS.sourceBlobBytes });
      }
      files.set(graph.snapshotId, map);
    }
    return new SourceAttachment({ attached: true }, git, files);
  }

  async read(snapshotId: string, nodeId: string): Promise<SourceResult> {
    if (!this.status.attached || !this.git) return { ok: false, status: 403, reason: this.status.attached ? 'NOT_ATTACHED' : this.status.reason };
    if (!/^snap_[0-9a-f]{64}$/.test(snapshotId) || !/^node_[0-9a-f]{64}$/.test(nodeId)) return { ok: false, status: 404, reason: 'UNKNOWN_FILE' };
    const file = this.files.get(snapshotId)?.get(nodeId);
    if (!file) return { ok: false, status: 404, reason: 'UNKNOWN_FILE' };
    if (!file.supported) return { ok: false, status: 409, reason: 'SOURCE_UNAVAILABLE_FOR_OPAQUE_FILE' };
    const [info] = await batchCheck(this.git, [file.blobOid]);
    if (!info || info.type !== 'blob' || info.size === null) return { ok: false, status: 404, reason: 'OBJECT_MISSING' };
    if (info.size > LIMITS.sourceBlobBytes) return { ok: false, status: 413, reason: 'SOURCE_TOO_LARGE' };
    const bytes = (await readObjects(this.git, [{ oid: file.blobOid, size: info.size }])).get(file.blobOid)!.bytes;
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return { ok: false, status: 409, reason: 'SOURCE_NOT_UTF8' };
    }
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return { ok: true, path: file.path, text, lineCount: text.length === 0 ? 0 : text.split('\n').length };
  }

  async dispose(): Promise<void> {
    await this.git?.dispose();
  }
}
