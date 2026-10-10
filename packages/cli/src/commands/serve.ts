import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { readArtifactDirectory } from '@atlas/artifact/node';
import { EXIT, UsageError, type CommandContext } from '../context.js';
import { SourceAttachment } from '../server/source.js';
import { startViewerServer } from '../server/server.js';
import { check } from '../ui/format.js';
import { PALETTE } from '../ui/style.js';

/** Locate the built viewer shipped with @atlas/web. */
export function viewerDirectory(): string {
  const require = createRequire(import.meta.url);
  const dir = path.join(path.dirname(require.resolve('@atlas/web/package.json')), 'dist');
  if (!existsSync(path.join(dir, 'index.html'))) throw new UsageError('The viewer is not built. Run: pnpm --filter @atlas/web build');
  return dir;
}

/** Open a URL we constructed ourselves, with no shell involved. */
function openBrowser(url: string): void {
  const [command, args] =
    process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  const child = spawn(command, args as string[], { stdio: 'ignore', detached: true, shell: false, windowsHide: true });
  child.on('error', () => undefined);
  child.unref();
}

const SOURCE_REASONS: Record<string, string> = {
  NOT_REQUESTED: 'not attached (start with --repo <dir> to read source)',
  NOT_A_REPOSITORY: 'the --repo path is not a Git repository',
  COMMIT_NOT_FOUND: 'the analyzed commit is not in that repository',
  FIRST_PARENT_MISMATCH: 'the analyzed commit history does not match',
  TREE_MISMATCH: 'committed files differ from the artifact',
  OBJECT_FORMAT_MISMATCH: 'the repository uses a different object format',
};

export async function serve(ctx: CommandContext, args: { artifact: string; repo?: string; open: boolean; port?: number; viewerDir?: string }): Promise<number> {
  const dir = path.resolve(ctx.io.cwd, args.artifact);
  const loaded = await readArtifactDirectory(dir);
  if (!loaded.ok) {
    ctx.note(`  ${check(ctx.err, false)} ${loaded.code}: the artifact did not validate. Run atlas verify for details.`);
    return EXIT.failure;
  }
  const source = args.repo ? await SourceAttachment.attach(path.resolve(ctx.io.cwd, args.repo), loaded.bundle) : SourceAttachment.none();
  const server = await startViewerServer({ artifactDir: dir, bundle: loaded.bundle, viewerDir: args.viewerDir ?? viewerDirectory(), source, ...(args.port !== undefined ? { port: args.port } : {}) });
  const s = ctx.err;
  if (ctx.json) ctx.print(JSON.stringify({ type: 'serving', url: server.url, sessionUrl: server.sessionUrl, source: source.status }));
  else {
    ctx.note();
    ctx.note(`  ${s.fg(PALETTE.brand, s.unicode ? '◆' : '*')} ${s.bold('ATLAS')} ${s.dim('· local viewer')}`);
    ctx.note();
    ctx.note(`  ${s.fg(PALETTE.muted, 'open'.padEnd(10))}${s.fg(PALETTE.accent, server.sessionUrl)}`);
    ctx.note(`  ${s.fg(PALETTE.muted, ''.padEnd(10))}${s.dim('one-time link; it signs this browser in and then stops working')}`);
    ctx.note(`  ${s.fg(PALETTE.muted, 'source'.padEnd(10))}${source.status.attached ? s.fg(PALETTE.ok, 'attached, read-only, verified against committed trees') : s.dim(SOURCE_REASONS[source.status.reason] ?? source.status.reason)}`);
    ctx.note(`  ${s.fg(PALETTE.muted, 'network'.padEnd(10))}${s.dim('127.0.0.1 only · nothing is uploaded')}`);
    ctx.note();
    ctx.note(s.dim('  Press Ctrl+C to stop.'));
  }
  if (args.open) openBrowser(server.sessionUrl);
  await new Promise<void>((resolve) => {
    if (ctx.io.signal.aborted) resolve();
    ctx.io.signal.addEventListener('abort', () => resolve(), { once: true });
  });
  await server.close();
  await source.dispose();
  if (!ctx.json) ctx.note(s.dim('\n  Stopped.\n'));
  return EXIT.ok;
}
