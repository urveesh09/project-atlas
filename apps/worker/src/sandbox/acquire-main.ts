import { createConnection } from 'node:net';
import path from 'node:path';
import { acquireGithubCommit, isIngestError } from '@atlas/ingest';
import { encodeFrame, FRAME } from '../protocol.js';
import { ACQUIRED_GIT_DIR, AcquireSpecSchema } from './spec.js';

/**
 * Acquisition sandbox entrypoint (plan §8.3). Trusted Git fetches one validated commit
 * into a fresh (or, when deepening, the same) ATLAS-owned bare repository. Its container
 * reaches only the egress broker; the broker resolves, pins and counts every byte.
 */
async function waitForBroker(proxy: string, deadline: number): Promise<void> {
  const { hostname, port } = new URL(proxy);
  while (Date.now() < deadline) {
    const reachable = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ host: hostname, port: Number(port) });
      socket.setTimeout(500);
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => resolve(false));
      socket.once('timeout', () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (reachable) return;
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function main(): Promise<number> {
  // Everything written into the bind-mounted job directory stays removable by the worker,
  // whatever its uid. The job root itself is private (0700) on the host.
  process.umask(0o000);
  const spec = AcquireSpecSchema.parse(JSON.parse(process.argv[2] ?? ''));
  const write = (value: unknown) => new Promise<void>((resolve) => process.stdout.write(encodeFrame({ type: FRAME.RESULT, value }), () => resolve()));
  try {
    if (spec.source.kind === 'github' && spec.source.proxy) await waitForBroker(spec.source.proxy, Date.now() + 10_000);
    const acquired = await acquireGithubCommit({ owner: spec.owner, name: spec.name }, spec.commitOid, {
      depth: spec.depth,
      maxBytes: spec.maxBytes,
      timeoutMs: spec.timeoutMs,
      filter: 'none',
      scratchDir: path.join(spec.target, ACQUIRED_GIT_DIR),
      ...(spec.source.kind === 'github' && spec.source.proxy ? { proxy: spec.source.proxy } : {}),
      ...(spec.source.kind === 'fixture' ? { fixtureRemote: spec.source.remote } : {}),
    });
    await write({ ok: true, bytesOnDisk: acquired.bytesOnDisk });
    return 0;
  } catch (error) {
    await write({ ok: false, code: isIngestError(error) ? error.code : 'GIT_FAILED' });
    return 2;
  }
}

main().then(
  (code) => process.exit(code),
  () => process.exit(70),
);
