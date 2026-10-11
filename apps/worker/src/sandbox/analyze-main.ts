import { AnalysisError, analyzeCommit } from '@atlas/analyzer-core';
import { MANIFEST_PATH } from '@atlas/artifact';
import { gzipDeterministic } from '@atlas/artifact/node';
import { SafeGit, gitVersion, isIngestError } from '@atlas/ingest';
import { hostedRepositoryId } from '@atlas/schema';
import { encodeFrame, FRAME, type Frame } from '../protocol.js';
import { AnalyzeSpecSchema, type SandboxProgress } from './spec.js';

/**
 * Offline analysis sandbox entrypoint (ADR-030, ADR-031). It runs the same analyzer as the
 * CLI over a read-only object store, with no network and no repository execution, and
 * reports only framed artifact bytes and fixed codes on stdout. It never writes outside
 * its scratch directory and holds no service credential.
 */
const write = (frame: Frame) =>
  new Promise<void>((resolve, reject) => {
    process.stdout.write(encodeFrame(frame), (error) => (error ? reject(error) : resolve()));
  });

async function main(): Promise<number> {
  const spec = AnalyzeSpecSchema.parse(JSON.parse(process.argv[2] ?? ''));
  const git = await SafeGit.create({ objectDirectory: spec.objects, objectFormat: spec.objectFormat, network: { kind: 'offline' }, scratchRoot: spec.scratch });
  let lastProgress = 0;
  const progress = (event: SandboxProgress) => {
    const now = Date.now();
    if (now - lastProgress < 250 && event.stage !== 'frames' && event.stage !== 'layout') return;
    lastProgress = now;
    void write({ type: FRAME.PROGRESS, value: event });
  };
  try {
    const result = await analyzeCommit({
      git,
      commitOid: spec.commitOid,
      gitVersion: await gitVersion(),
      repository: {
        repoId: hostedRepositoryId(spec.repository.numericId),
        displayName: `${spec.repository.owner}/${spec.repository.name}`,
        sourceKind: 'public-github',
        remote: { host: 'github.com', owner: spec.repository.owner, name: spec.repository.name, numericId: spec.repository.numericId },
        objectFormat: spec.objectFormat,
      },
      options: { history: { enabled: spec.history } },
      ...(spec.checkpoint ? { historyUnavailable: { code: 'HISTORY_NOT_ACQUIRED' as const } } : {}),
      deadlineMs: spec.deadlineMs,
      transport: gzipDeterministic,
      onProgress: (event) => progress({ stage: event.stage, ...(event.done !== undefined ? { done: event.done } : {}), ...(event.total !== undefined ? { total: event.total } : {}) }),
    });
    const packed = result.packed!;
    for (const [name, bytes] of packed.chunks) await write({ type: FRAME.FILE, name, bytes: Buffer.from(bytes) });
    await write({ type: FRAME.FILE, name: MANIFEST_PATH, bytes: Buffer.from(`${JSON.stringify(packed.manifest, null, 2)}\n`) });
    await write({ type: FRAME.RESULT, value: { ok: true, status: result.status } });
    return 0;
  } catch (error) {
    const code = error instanceof AnalysisError ? error.code : isIngestError(error) ? error.code : 'ANALYSIS_FAILED';
    const limit = error instanceof AnalysisError && typeof error.details['limit'] === 'string' ? error.details['limit'] : null;
    await write({ type: FRAME.RESULT, value: { ok: false, code: /^[A-Z_]{1,64}$/.test(code) ? code : 'ANALYSIS_FAILED', limit: limit && /^[A-Z_]{1,64}$/.test(limit) ? limit : null } });
    return 2;
  } finally {
    await git.dispose().catch(() => undefined);
  }
}

main().then(
  (code) => process.exit(code),
  () => process.exit(70),
);
