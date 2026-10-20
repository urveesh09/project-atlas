import { execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Deterministic fixture repositories built with the trusted local Git. Fixture creation
 * never reads the developer's global/system Git configuration (which could, for example,
 * enforce commit signing), so commit IDs depend only on the authored content and dates.
 */
export interface FixtureCommit {
  /** ISO-8601 timestamp used for both author and committer dates. */
  date: string;
  message: string;
  /** Files to write (string or bytes) or delete (null), applied in order. */
  files?: Record<string, string | Uint8Array | null>;
  /** Renames applied before `files` (git detects them from content similarity). */
  renames?: readonly [from: string, to: string][];
  /** Optional ref names to point at this commit after it is created. */
  branch?: string;
  tag?: { name: string; annotated: boolean };
}

export interface GitFixture {
  dir: string;
  commits: string[];
  git(args: readonly string[], input?: string | Buffer): string;
  dispose(): void;
}

let emptyConfigFile: string | null = null;

function fixtureEnv(date?: string): NodeJS.ProcessEnv {
  if (!emptyConfigFile) {
    const dir = mkdtempSync(path.join(tmpdir(), 'atlas-fixture-cfg-'));
    emptyConfigFile = path.join(dir, 'empty');
    writeFileSync(emptyConfigFile, '');
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: emptyConfigFile,
    GIT_AUTHOR_NAME: 'ATLAS Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@atlas.invalid',
    GIT_COMMITTER_NAME: 'ATLAS Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@atlas.invalid',
    GIT_TERMINAL_PROMPT: '0',
  };
  if (date) {
    env['GIT_AUTHOR_DATE'] = date;
    env['GIT_COMMITTER_DATE'] = date;
  }
  return env;
}

export function runGit(dir: string, args: readonly string[], options: { input?: string | Buffer; date?: string; timeoutMs?: number } = {}): string {
  return execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.hooksPath=', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], {
    cwd: dir,
    env: fixtureEnv(options.date),
    input: options.input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 256 * 1024 * 1024,
    timeout: options.timeoutMs ?? 120_000,
  });
}

export function createGitFixture(commits: readonly FixtureCommit[], options: { objectFormat?: 'sha1' | 'sha256'; parent?: string } = {}): GitFixture {
  const dir = mkdtempSync(path.join(options.parent ?? tmpdir(), 'atlas-fixture-'));
  runGit(dir, ['init', '-q', '-b', 'main', ...(options.objectFormat === 'sha256' ? ['--object-format=sha256'] : [])]);
  const oids: string[] = [];
  for (const commit of commits) {
    for (const [from, to] of commit.renames ?? []) {
      mkdirSync(path.dirname(path.join(dir, to)), { recursive: true });
      renameSync(path.join(dir, from), path.join(dir, to));
    }
    for (const [file, content] of Object.entries(commit.files ?? {})) {
      const full = path.join(dir, file);
      if (content === null) rmSync(full, { force: true });
      else {
        mkdirSync(path.dirname(full), { recursive: true });
        writeFileSync(full, content);
      }
    }
    runGit(dir, ['add', '-A']);
    runGit(dir, ['commit', '-q', '--allow-empty', '--no-verify', '-m', commit.message], { date: commit.date });
    const oid = runGit(dir, ['rev-parse', 'HEAD']).trim();
    oids.push(oid);
    if (commit.branch) runGit(dir, ['branch', '-f', commit.branch, oid]);
    if (commit.tag) {
      runGit(dir, ['tag', ...(commit.tag.annotated ? ['-a', '-m', commit.tag.name] : []), commit.tag.name, oid], { date: commit.date });
    }
  }
  return {
    dir,
    commits: oids,
    git: (args, input) => runGit(dir, args, input === undefined ? {} : { input }),
    dispose: () => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
  };
}

/**
 * The same repository as `createGitFixture` from one `git fast-import` stream: identical
 * commits, trees and IDs (tested), but objects and the `main` ref only, with no checkout.
 * One Git process instead of several per commit, so large histories build in seconds on
 * every platform (Windows process creation made the per-commit path take minutes).
 * Branches and tags are not supported; messages must already be in the form
 * `git commit -m` stores, and dates must carry an explicit offset (`Z` or `±HH:MM`).
 */
export function importGitFixture(commits: readonly FixtureCommit[], options: { objectFormat?: 'sha1' | 'sha256'; parent?: string } = {}): GitFixture {
  const dir = mkdtempSync(path.join(options.parent ?? tmpdir(), 'atlas-fixture-'));
  runGit(dir, ['init', '-q', '-b', 'main', ...(options.objectFormat === 'sha256' ? ['--object-format=sha256'] : [])]);
  const quote = (p: string) => `"${p.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
  const data = (bytes: Buffer) => [Buffer.from(`data ${bytes.length}\n`), bytes, Buffer.from('\n')];
  const identity = (date: string) => {
    const zone = /(Z|[+-]\d{2}:\d{2})$/.exec(date)?.[1];
    const seconds = Date.parse(date) / 1000;
    if (zone === undefined || !Number.isInteger(seconds)) throw new Error(`Fixture date needs whole seconds and an explicit offset: ${date}`);
    return `ATLAS Fixture <fixture@atlas.invalid> ${seconds} ${zone === 'Z' ? '+0000' : zone.replace(':', '')}`;
  };
  const stream: Buffer[] = [];
  commits.forEach((commit, i) => {
    if (commit.branch || commit.tag) throw new Error('importGitFixture does not create branches or tags; use createGitFixture');
    // `git commit -m` stores the message with surrounding blank lines and trailing spaces removed.
    const message = commit.message.split('\n').map((line) => line.trimEnd()).join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '');
    if (message !== commit.message || message === '') throw new Error('Fixture messages must be non-empty and already in committed form');
    stream.push(Buffer.from(`commit refs/heads/main\nmark :${i + 1}\nauthor ${identity(commit.date)}\ncommitter ${identity(commit.date)}\n`), ...data(Buffer.from(`${message}\n`)));
    if (i > 0) stream.push(Buffer.from(`from :${i}\n`));
    for (const [from, to] of commit.renames ?? []) stream.push(Buffer.from(`R ${quote(from)} ${quote(to)}\n`));
    for (const [file, content] of Object.entries(commit.files ?? {})) {
      if (content === null) stream.push(Buffer.from(`D ${quote(file)}\n`));
      else stream.push(Buffer.from(`M 100644 inline ${quote(file)}\n`), ...data(typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content)));
    }
    stream.push(Buffer.from('\n'));
  });
  runGit(dir, ['fast-import', '--quiet', '--done'], { input: Buffer.concat([...stream, Buffer.from('done\n')]), timeoutMs: 600_000 });
  const oids = commits.length === 0 ? [] : runGit(dir, ['rev-list', '--reverse', '--first-parent', 'main']).trim().split('\n');
  if (oids.length !== commits.length) throw new Error('fast-import did not create every fixture commit');
  return {
    dir,
    commits: oids,
    git: (args, input) => runGit(dir, args, input === undefined ? {} : { input }),
    dispose: () => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
  };
}

export interface RawTreeEntry {
  mode: '100644' | '100755' | '120000' | '160000';
  /** Raw path bytes (may be invalid UTF-8) or a string. */
  path: string | Buffer;
  /** Blob content for blob/symlink modes; a commit OID for submodules. */
  content: string | Buffer;
}

/**
 * Build a commit whose tree is constructed directly with `git mktree`, bypassing the
 * filesystem. This produces entries no checkout could (invalid UTF-8, newlines,
 * case-distinct names on Windows, symlinks and gitlinks).
 */
export function commitRawTree(fixture: GitFixture, entries: readonly RawTreeEntry[], options: { date: string; message: string; parent?: string }): string {
  interface Dir {
    files: { mode: string; type: string; oid: string; name: Buffer }[];
    dirs: Map<string, Dir>;
  }
  const root: Dir = { files: [], dirs: new Map() };
  for (const entry of entries) {
    const raw = typeof entry.path === 'string' ? Buffer.from(entry.path, 'utf8') : entry.path;
    const segments: Buffer[] = [];
    let start = 0;
    for (let i = 0; i <= raw.length; i++) {
      if (i === raw.length || raw[i] === 0x2f) {
        segments.push(raw.subarray(start, i));
        start = i + 1;
      }
    }
    let dir = root;
    for (const segment of segments.slice(0, -1)) {
      const key = segment.toString('binary');
      if (!dir.dirs.has(key)) dir.dirs.set(key, { files: [], dirs: new Map() });
      dir = dir.dirs.get(key)!;
    }
    let oid: string;
    let type = 'blob';
    if (entry.mode === '160000') {
      oid = entry.content.toString();
      type = 'commit';
    } else {
      oid = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: fixture.dir, env: fixtureEnv(), input: entry.content }).toString().trim();
    }
    dir.files.push({ mode: entry.mode, type, oid, name: segments.at(-1)! });
  }
  const writeTree = (dir: Dir): string => {
    const lines: Buffer[] = [];
    for (const [name, child] of dir.dirs) {
      lines.push(Buffer.concat([Buffer.from(`040000 tree ${writeTree(child)}\t`), Buffer.from(name, 'binary'), Buffer.from([0])]));
    }
    for (const file of dir.files) lines.push(Buffer.concat([Buffer.from(`${file.mode} ${file.type} ${file.oid}\t`), file.name, Buffer.from([0])]));
    return execFileSync('git', ['mktree', '-z', '--missing'], { cwd: fixture.dir, env: fixtureEnv(), input: Buffer.concat(lines) }).toString().trim();
  };
  const tree = writeTree(root);
  const parentArgs = options.parent ? ['-p', options.parent] : [];
  const oid = execFileSync('git', ['commit-tree', tree, ...parentArgs, '-m', options.message], { cwd: fixture.dir, env: fixtureEnv(options.date) })
    .toString()
    .trim();
  return oid;
}

/**
 * Arm a repository with configuration and hooks that would execute a sentinel script
 * if Git ever honored them (plan §16.3). Returns the directory where sentinels appear.
 */
export function armExecutionTraps(fixture: GitFixture): { sentinelDir: string; script: string } {
  const sentinelDir = mkdtempSync(path.join(tmpdir(), 'atlas-sentinel-'));
  const posix = (p: string) => p.replaceAll('\\', '/');
  const script = path.join(sentinelDir, 'trap.sh');
  writeFileSync(script, `#!/bin/sh\necho triggered > "${posix(sentinelDir)}/sentinel-$1"\nexit 0\n`);
  chmodSync(script, 0o755);
  const run = (name: string) => `"${posix(script)}" ${name}`;
  const gitDir = path.join(fixture.dir, '.git');
  const hooksDir = path.join(gitDir, 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  for (const hook of ['pre-commit', 'post-checkout', 'post-merge', 'pre-push', 'reference-transaction', 'post-index-change', 'fsmonitor-watchman']) {
    writeFileSync(path.join(hooksDir, hook), `#!/bin/sh\n${run(`hook-${hook}`)}\n`);
    chmodSync(path.join(hooksDir, hook), 0o755);
  }
  const config = [
    '[core]',
    `\tfsmonitor = ${run('fsmonitor')}`,
    `\tpager = ${run('pager')}`,
    `\tsshCommand = ${run('ssh')}`,
    `\talternateRefsCommand = ${run('alternate-refs')}`,
    `\tattributesFile = ${posix(path.join(sentinelDir, 'attributes'))}`,
    '[diff]',
    `\texternal = ${run('diff-external')}`,
    '[diff "trap"]',
    `\ttextconv = ${run('textconv')}`,
    `\tcommand = ${run('diff-driver')}`,
    '[filter "trap"]',
    `\tclean = ${run('filter-clean')}`,
    `\tsmudge = ${run('filter-smudge')}`,
    `\tprocess = ${run('filter-process')}`,
    '\trequired = true',
    '[credential]',
    `\thelper = !${run('credential')}`,
    '[uploadpack]',
    `\tpackObjectsHook = ${run('pack-objects-hook')}`,
    '[remote "trap"]',
    `\turl = ext::sh -c ${posix(script)}% lazy-fetch`,
    '\tpromisor = true',
    '[alias]',
    `\tdiff-tree = !${run('alias')}`,
    `\tcat-file = !${run('alias')}`,
    '',
  ].join('\n');
  appendFileSync(path.join(gitDir, 'config'), `\n${config}`);
  writeFileSync(path.join(sentinelDir, 'attributes'), '* filter=trap diff=trap\n');
  writeFileSync(path.join(fixture.dir, '.gitattributes'), '* filter=trap diff=trap\n');
  return { sentinelDir, script };
}

