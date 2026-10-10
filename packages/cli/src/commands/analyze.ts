import { stat } from 'node:fs/promises';
import path from 'node:path';
import { AnalysisError, OptionsError, analyzeCommit, type ProgressEvent } from '@atlas/analyzer-core';
import { ArtifactWriteError, gzipDeterministic, packArtifact, readArtifactDirectory, writeArtifactDirectory } from '@atlas/artifact/node';
import { IngestError, gitVersion, openLocalRepository, readCommit, resolveLocalCommit } from '@atlas/ingest';
import { repoBasename } from '@atlas/schema';
import { EXIT, UsageError, type CommandContext } from '../context.js';
import { REPOSITORY_ID_FILE, identityFromUuid, newIdentity, readIdentity, type RepositoryIdentity } from '../repository-id.js';
import { check, formatBytes, formatCount, formatDuration, plural } from '../ui/format.js';
import { PALETTE } from '../ui/style.js';

export interface AnalyzeArgs {
  repo: string;
  out: string;
  ref?: string;
  repoId?: string;
  previous?: string;
  replace: boolean;
  exclude: string[];
  maxFiles?: number;
  history: { enabled: boolean; days?: number; commits?: number; snapshots?: number };
}

const STAGE_LABEL: Record<ProgressEvent['stage'], string> = {
  resolve: 'Read commit',
  enumerate: 'Enumerate tree',
  inventory: 'Inventory files',
  hierarchy: 'Packages & configuration',
  parse: 'Parse TS/JS',
  dependencies: 'Resolve imports',
  findings: 'Metrics & findings',
  layout: 'Lay out city',
  assemble: 'Assemble artifact',
};

/** Stage progress: rewritten in place on a TTY, one line per finished stage otherwise. */
class StageReporter {
  private current: ProgressEvent['stage'] | null = null;
  private started = performance.now();
  private readonly tty: boolean;
  constructor(private readonly ctx: CommandContext) {
    this.tty = ctx.io.stderr.isTTY === true && !ctx.json;
  }
  update(event: ProgressEvent) {
    if (this.current !== event.stage) {
      this.finish();
      this.current = event.stage;
      this.started = performance.now();
    }
    if (this.tty) {
      const counts = event.total ? this.ctx.err.dim(`  ${formatCount(event.done ?? 0)}/${formatCount(event.total)}`) : '';
      this.ctx.io.stderr.write(`\r\u001b[2K  ${this.ctx.err.fg(PALETTE.accent, '◌')} ${STAGE_LABEL[event.stage]}${counts}`);
    }
  }
  finish(detail = '') {
    if (!this.current) return;
    const s = this.ctx.err;
    const label = STAGE_LABEL[this.current].padEnd(26);
    const line = `  ${check(s, true)} ${label}${s.dim(formatDuration(performance.now() - this.started).padStart(7))}${detail ? `  ${detail}` : ''}`;
    this.ctx.io.stderr.write(this.tty ? `\r\u001b[2K${line}\n` : `${line}\n`);
    this.current = null;
  }
}

async function resolveIdentity(args: AnalyzeArgs, out: string, cwd: string): Promise<RepositoryIdentity> {
  if (args.repoId) {
    try {
      return identityFromUuid(args.repoId);
    } catch {
      throw new UsageError('--repo-id must be a lowercase UUID (see repository-id.json in a previous artifact)');
    }
  }
  if (args.previous) {
    const previous = path.resolve(cwd, args.previous);
    const loaded = await readArtifactDirectory(previous);
    if (!loaded.ok) throw new UsageError(`--previous is not a valid ATLAS artifact (${loaded.issues[0]?.code ?? loaded.code})`);
    const identity = await readIdentity(previous);
    if (!identity || identity.repoId !== loaded.bundle.manifest.repo.repoId) throw new UsageError(`--previous has no matching ${REPOSITORY_ID_FILE}`);
    return identity;
  }
  // Re-running into the same output keeps the same identity.
  return (await readIdentity(out)) ?? newIdentity();
}

export async function analyze(ctx: CommandContext, args: AnalyzeArgs): Promise<number> {
  const s = ctx.err;
  const started = performance.now();
  const repoPath = path.resolve(ctx.io.cwd, args.repo);
  const out = path.resolve(ctx.io.cwd, args.out);
  const repoInfo = await stat(repoPath).catch(() => null);
  if (!repoInfo?.isDirectory()) throw new UsageError(`Repository path is not a directory: ${args.repo}`);

  const identity = await resolveIdentity(args, out, ctx.io.cwd);
  const { repo, git } = await openLocalRepository(repoPath);
  try {
    const commitOid = await resolveLocalCommit(repo, git, args.ref, ctx.io.signal);
    const commit = await readCommit(git, commitOid, ctx.io.signal);
    const displayName = repoBasename(path.basename(repo.worktreeRoot ?? repoPath).replace(/\.git$/, '')) || 'repository';

    if (!ctx.json) {
      ctx.note();
      ctx.note(`  ${s.fg(PALETTE.brand, s.unicode ? '◆' : '*')} ${s.bold('ATLAS')} ${s.dim('· committed-tree analysis')}`);
      ctx.note();
      ctx.note(`  ${s.fg(PALETTE.muted, 'repository'.padEnd(12))}${s.bold(displayName)}`);
      ctx.note(`  ${s.fg(PALETTE.muted, 'commit'.padEnd(12))}${s.fg(PALETTE.brand, commitOid.slice(0, 12))}${args.ref ? s.dim(`  (${args.ref})`) : ''}  ${s.dim(new Date(commit.committerEpochSeconds * 1000).toISOString().slice(0, 10))}`);
      ctx.note(`  ${s.fg(PALETTE.muted, 'scope'.padEnd(12))}committed files only ${s.dim('— working-tree edits and untracked files are not included')}`);
      ctx.note();
    } else {
      ctx.print(JSON.stringify({ type: 'start', commit: commitOid, scope: 'committed-tree' }));
    }

    const reporter = new StageReporter(ctx);
    const result = await analyzeCommit({
      git,
      commitOid,
      gitVersion: await gitVersion(),
      repository: { repoId: identity.repoId, displayName, sourceKind: 'local-git', remote: null, objectFormat: repo.objectFormat },
      options: { exclude: args.exclude, history: args.history, ...(args.maxFiles !== undefined ? { limits: { includedFiles: args.maxFiles } } : {}) },
      signal: ctx.io.signal,
      onProgress: (event) => {
        if (ctx.json && (event.total === undefined || event.done === event.total)) ctx.print(JSON.stringify({ type: 'progress', ...event }));
        else if (!ctx.json) reporter.update(event);
      },
    });
    const summary = result.summary;
    reporter.finish(s.dim(`${plural(summary.files.included, 'file')} · ${plural(summary.packages.length, 'package')}`));

    const packed = packArtifact(result.draft, gzipDeterministic);
    const writeStarted = performance.now();
    await writeArtifactDirectory(packed, out, {
      replace: args.replace,
      protectedPaths: [repoPath, repo.gitDir, repo.commonDir, ...(repo.worktreeRoot ? [repo.worktreeRoot] : [])],
      extras: { 'summary.json': summary, [REPOSITORY_ID_FILE]: identity },
    });
    const bytes = [...packed.chunks.values()].reduce((a, b) => a + b.length, 0);
    const relativeOut = path.relative(ctx.io.cwd, out) || '.';
    if (ctx.json) {
      ctx.print(JSON.stringify({ type: 'result', status: result.status, output: relativeOut, analysisId: packed.manifest.analysisId, repoId: identity.repoId, commit: commitOid, artifactBytes: bytes, summary }));
    } else {
      ctx.note(`  ${check(s, true)} ${'Write artifact'.padEnd(26)}${s.dim(formatDuration(performance.now() - writeStarted).padStart(7))}  ${s.fg(PALETTE.accent, relativeOut)} ${s.dim(`(${formatBytes(bytes)})`)}`);
      ctx.note();
      const f = summary.files;
      ctx.note(`  ${s.bold(formatCount(f.included))} files in ${s.bold(String(summary.packages.length))} ${summary.packages.length === 1 ? 'package' : 'packages'}  ${s.dim(`· ${formatCount(f.supported)} TS/JS · ${formatCount(f.opaque)} other · ${formatCount(f.excluded)} excluded · ${formatCount(f.omitted)} omitted`)}`);
      for (const root of summary.excludedRoots.slice(0, 3)) ctx.note(s.dim(`  excluded ${root.path} (${plural(root.files, 'file')}, ${root.reason.toLowerCase().replaceAll('_', ' ')})`));
      if (result.status === 'partial') ctx.note(`  ${check(s, 'warn')} ${s.fg(PALETTE.warn, `Partial: limits reached (${summary.limitsHit.join(', ')}).`)} ${s.dim('Omitted files are listed in coverage.')}`);
      ctx.note();
      ctx.note(`  Done in ${formatDuration(performance.now() - started)} ${s.dim('·')} ${result.status === 'complete' ? s.fg(PALETTE.ok, 'complete') : s.fg(PALETTE.warn, 'partial')}`);
      ctx.note(s.dim('  The artifact reveals paths, package names and commit IDs. It never contains source text.'));
      ctx.note(`  ${s.dim('Next:')} atlas inspect ${relativeOut}`);
      ctx.note();
    }
    return result.status === 'complete' ? EXIT.ok : EXIT.partial;
  } finally {
    await git.dispose();
  }
}

/** Map library errors to stable exit codes and one-line messages. */
export function analyzeErrorExit(error: unknown): { exit: number; message: string } | null {
  if (error instanceof UsageError || error instanceof OptionsError) return { exit: EXIT.usage, message: error.message };
  if (error instanceof IngestError) {
    if (error.code === 'REF_INVALID') return { exit: EXIT.usage, message: `${error.code}: ${error.message}` };
    if (error.code === 'CANCELLED') return { exit: EXIT.cancelled, message: 'Cancelled; no output was changed.' };
    return { exit: EXIT.failure, message: `${error.code}: ${error.message}` };
  }
  if (error instanceof AnalysisError) {
    if (error.code === 'CANCELLED') return { exit: EXIT.cancelled, message: 'Cancelled; no output was changed.' };
    return { exit: EXIT.failure, message: `${error.code}: ${error.message}` };
  }
  if (error instanceof ArtifactWriteError) return { exit: EXIT.failure, message: `${error.code}: ${error.message}` };
  return null;
}
