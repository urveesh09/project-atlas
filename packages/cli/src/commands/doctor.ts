import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ANALYZER_VERSION, PARSER_VERSIONS } from '@atlas/analyzer-core';
import { SafeGit, gitVersion } from '@atlas/ingest';
import { ARTIFACT_VERSION, GRAPH_SCHEMA_VERSION, LIMITS, RELEASE_PROFILE } from '@atlas/schema';
import { EXIT, type CommandContext } from '../context.js';
import { check, formatBytes, formatCount } from '../ui/format.js';
import { PALETTE } from '../ui/style.js';

/**
 * `atlas doctor` (plan §14.1): runtime, Git and parser versions, supported object formats
 * and a sanitized-Git self test. Never prints credentials, configuration or environment.
 */
interface Check {
  id: string;
  label: string;
  status: 'ok' | 'fail' | 'warn' | 'info';
  detail: string;
}

const MIN_GIT: [number, number] = [2, 38];
const MIN_NODE: [number, number] = [24, 22];

function compareVersion(version: string, min: [number, number]): boolean {
  const [major = 0, minor = 0] = version.split('.').map((p) => Number.parseInt(p, 10));
  return major > min[0] || (major === min[0] && minor >= min[1]);
}

export async function doctor(ctx: CommandContext): Promise<number> {
  const checks: Check[] = [];
  const node = process.versions.node;
  const [nodeMajor = 0] = node.split('.').map(Number);
  const nodeStatus = nodeMajor !== MIN_NODE[0] ? 'fail' : compareVersion(node, MIN_NODE) ? 'ok' : 'warn';
  const minimumNode = `${MIN_NODE.join('.')}.0`;
  const nodeAdvice = nodeStatus === 'fail' ? `  (requires 24.x; minimum ${minimumNode})`
    : nodeStatus === 'warn' ? `  (upgrade to ${minimumNode} or newer 24.x for security fixes)` : '';
  checks.push({ id: 'node', label: 'Node.js', status: nodeStatus, detail: `${node}${nodeAdvice}` });

  let git: string | null = null;
  try {
    git = await gitVersion();
    const supported = compareVersion(git, MIN_GIT);
    checks.push({ id: 'git', label: 'Git', status: supported ? 'ok' : 'fail', detail: supported ? `${git}  (SHA-1 and SHA-256 object formats)` : `${git}  (requires ${MIN_GIT.join('.')} or newer)` });
  } catch {
    checks.push({ id: 'git', label: 'Git', status: 'fail', detail: 'not found on PATH; install Git 2.38 or newer' });
  }

  // Self test: an offline sanitized Git must refuse every transport.
  if (git) {
    const safe = await SafeGit.create({ objectDirectory: null, objectFormat: 'sha1', network: { kind: 'offline' } });
    try {
      const probe = await safe.run(['ls-remote', 'https://github.com/octocat/Hello-World.git'], { timeoutMs: 15_000, maxStdoutBytes: 4096, okExitCodes: [0, 1, 128] });
      const blocked = probe.exitCode !== 0;
      checks.push({ id: 'isolation', label: 'Isolation', status: blocked ? 'ok' : 'fail', detail: blocked ? 'offline Git refuses network transports; repository config, hooks and helpers are never loaded' : 'offline Git reached the network' });
    } finally {
      await safe.dispose();
    }
  }

  checks.push({ id: 'parser', label: 'Parser', status: 'ok', detail: PARSER_VERSIONS });
  try {
    const dir = await mkdtemp(path.join(tmpdir(), 'atlas-doctor-'));
    await writeFile(path.join(dir, 'probe'), 'ok');
    await rm(dir, { recursive: true, force: true });
    checks.push({ id: 'scratch', label: 'Scratch', status: 'ok', detail: 'temporary directory is writable' });
  } catch {
    checks.push({ id: 'scratch', label: 'Scratch', status: 'fail', detail: 'temporary directory is not writable' });
  }
  checks.push({
    id: 'profile',
    label: 'Profile',
    status: 'info',
    detail: `${RELEASE_PROFILE} · ${formatCount(LIMITS.includedFilesPerSnapshot)} files · ${formatBytes(LIMITS.headDecodedSourceBytes)} source · ${formatBytes(LIMITS.sourceBlobBytes)} per file`,
  });
  checks.push({ id: 'contracts', label: 'Contracts', status: 'info', detail: `${ARTIFACT_VERSION} · ${GRAPH_SCHEMA_VERSION}` });

  const failed = checks.filter((c) => c.status === 'fail').length;
  const warnings = checks.filter((c) => c.status === 'warn').length;
  if (ctx.json) {
    ctx.print(JSON.stringify({ tool: 'atlas', version: ANALYZER_VERSION, ok: failed === 0, checks }, null, 2));
    return failed === 0 ? EXIT.ok : EXIT.failure;
  }
  const s = ctx.out;
  ctx.print();
  ctx.print(`  ${s.fg(PALETTE.brand, s.unicode ? '◆' : '*')} ${s.bold('ATLAS')} ${s.dim(`${ANALYZER_VERSION} · doctor`)}`);
  ctx.print();
  for (const c of checks) ctx.print(`  ${check(s, c.status === 'info' || c.status === 'warn' ? c.status : c.status === 'ok')} ${s.fg(PALETTE.muted, c.label.padEnd(11))}${c.detail}`);
  ctx.print();
  ctx.print(failed === 0 ? warnings > 0
    ? `  ${s.fg(PALETTE.warn, `Ready with ${warnings} warning${warnings === 1 ? '' : 's'}.`)} ${s.dim('Upgrade Node.js before analysis.')}`
    : `  ${s.fg(PALETTE.ok, 'Ready.')} ${s.dim('Try: atlas analyze . --out ./atlas-output')}`
    : `  ${s.fg(PALETTE.error, `${failed} check${failed === 1 ? '' : 's'} failed.`)}`);
  ctx.print();
  return failed === 0 ? EXIT.ok : EXIT.failure;
}
