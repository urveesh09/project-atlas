import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { acquireGithubCommit, runBounded } from '@atlas/ingest';
import { armExecutionTraps, buildDemoRepository, buildPythonDemoRepository, createGitFixture, runGit, type GitFixture } from '@atlas/test-fixtures';
import { expectPythonBundle, readPythonPublication } from './python-expectations.js';
import { DockerStageRunners, FRAME, FrameDecoder, runContainer, type SandboxRuntime } from '../src/index.js';
import { ScriptedRunners, createHarness, databaseUrl, submission, type Harness } from './pipeline-harness.js';

/**
 * Mandatory hosted security gates on a real Linux container engine (plan §16.3,
 * ADR-031). Opt-in like ADR-030's spike: ATLAS_CONTAINER_TESTS=1 with the immutable
 * sandbox image ID built from deploy/sandbox.Dockerfile, plus a test database.
 */
const enabled = process.env['ATLAS_CONTAINER_TESTS'] === '1';
const image = process.env['ATLAS_TEST_RUNTIME_IMAGE'];
if (enabled && !image) throw new Error('Container pipeline tests require ATLAS_TEST_RUNTIME_IMAGE (docker image inspect atlas-sandbox --format {{.Id}})');
const runtime = (): SandboxRuntime => ({
  docker: process.env['ATLAS_DOCKER_EXECUTABLE'] ?? 'docker',
  image: image!,
  cwd: process.cwd(),
  env: Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)),
});
/** Containers and networks this suite's job left behind (other suites may run concurrently). */
const leftovers = async (jobId: string) => {
  const r = runtime();
  const containers = await runBounded(r.docker, ['ps', '--all', '--filter', `label=atlas.job=${jobId}`, '--format', '{{.Names}}'], { cwd: r.cwd, env: r.env, timeoutMs: 10_000, maxStdoutBytes: 65536 });
  const networks = await runBounded(r.docker, ['network', 'ls', '--filter', `label=atlas.job=${jobId}`, '--format', '{{.Name}}'], { cwd: r.cwd, env: r.env, timeoutMs: 10_000, maxStdoutBytes: 65536 });
  return `${containers.stdout.toString('utf8')}${networks.stdout.toString('utf8')}`.trim();
};
/**
 * Fixture remotes are mounted read-only into the acquisition sandbox, which runs as uid
 * 10001. Test directories are private (mkdtemp 0700), so make the fixtures readable.
 */
const shareReadOnly = (dir: string) => {
  chmodSync(dir, 0o755);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) shareReadOnly(full);
    else chmodSync(full, 0o644);
  }
};
const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));

describe.runIf(enabled && !!databaseUrl)('hosted pipeline inside real containers (security gates)', () => {
  let demo: GitFixture;
  let python: GitFixture;
  let trapped: GitFixture;
  let sentinelDir: string;
  let remoteSentinels: string;
  let h: Harness;
  beforeAll(async () => {
    demo = buildDemoRepository();
    python = buildPythonDemoRepository();
    sentinelDir = mkdtempSync(path.join(tmpdir(), 'atlas-sentinel-hosted-'));
    // Committed content that would write sentinels if anything executed it: npm lifecycle
    // scripts, Git hooks managers, bundler configs, a TypeScript plugin, filter/diff
    // attributes and a submodule with an ext:: URL. Their targets cover the host sentinel
    // directory and both writable sandbox locations.
    const write = (name: string) => `node -e "for (const d of ['${sentinelDir.replaceAll('\\', '/')}','/acquired','/scratch','/tmp']) try { require('fs').writeFileSync(d + '/sentinel-${name}', 'x') } catch {}"`;
    trapped = createGitFixture([
      {
        date: '2026-09-01T10:00:00Z',
        message: 'trap repository',
        files: {
          'package.json': JSON.stringify({ name: 'trap', scripts: { preinstall: write('preinstall'), install: write('install'), postinstall: write('postinstall'), prepare: write('prepare'), test: write('test') } }),
          '.husky/pre-commit': `#!/bin/sh\n${write('husky')}\n`,
          '.githooks/post-checkout': `#!/bin/sh\n${write('githooks')}\n`,
          '.gitattributes': '* filter=trap diff=trap merge=trap\n',
          'tsconfig.json': JSON.stringify({ compilerOptions: { plugins: [{ name: 'trap-plugin' }] } }),
          'node_modules/trap-plugin/index.js': `${write('ts-plugin')}\n`,
          'vite.config.ts': `import { writeFileSync } from 'node:fs';\nwriteFileSync('/scratch/sentinel-vite', 'x');\nexport default {};\n`,
          'webpack.config.js': `require('fs').writeFileSync('/scratch/sentinel-webpack', 'x');\n`,
          '.gitmodules': '[submodule "evil"]\n\tpath = evil\n\turl = ext::sh -c touch% /acquired/sentinel-submodule\n',
          'src/index.ts': "import { helper } from './helper';\nexport const value = helper();\n",
          'src/helper.ts': 'export function helper() { return 1; }\n',
        },
      },
    ]);
    // The remote's own configuration is armed too (hooks, filters, helpers, aliases). It
    // is never committed: arming makes the remote's own `git add` run the trap filter.
    remoteSentinels = armExecutionTraps(trapped).sentinelDir;
    const head = trapped.commits.at(-1)!;
    shareReadOnly(demo.dir);
    shareReadOnly(python.dir);
    shareReadOnly(trapped.dir);
    h = await createHarness([
      { numericId: '737373', owner: 'atlas-demo', name: 'harbor', defaultBranch: 'main', headOid: demo.commits.at(-1)!, remotePath: demo.dir, visibility: 'public' },
      { numericId: '757575', owner: 'atlas-demo', name: 'harbor-python', defaultBranch: 'main', headOid: python.commits.at(-1)!, remotePath: python.dir, visibility: 'public' },
      { numericId: '747474', owner: 'atlas-demo', name: 'trap', defaultBranch: 'main', headOid: head, remotePath: trapped.dir, visibility: 'public' },
    ]);
  });
  beforeEach(async () => h.reset());
  afterAll(async () => {
    await h?.close();
    demo?.dispose();
    python?.dispose();
    trapped?.dispose();
    rmSync(sentinelDir, { recursive: true, force: true });
    rmSync(remoteSentinels, { recursive: true, force: true });
  });
  const docker = () => new DockerStageRunners(runtime(), { kind: 'fixture', remoteFor: (id) => (id === '747474' ? trapped.dir : id === '757575' ? python.dir : demo.dir) });

  it('publishes independently checked Python facts through the real offline sandbox', async () => {
    const job = await h.submit(submission('https://github.com/atlas-demo/harbor-python'));
    await h.coordinator(docker(), { publishReserveMs: 10_000 }).runOnce();
    const row = await h.job(job.jobId);
    expect(row.state).toBe('READY');
    expect(row.metrics.isolation).toBe('container');
    expect(row.warnings).toEqual([]);
    expectPythonBundle(await readPythonPublication(h.publications, row.analysis_id));
    expect(await leftovers(job.jobId)).toBe('');
  }, 240_000);

  it('runs the whole journey in containers and leaves no sandbox container or network behind', async () => {
    const job = await h.submit(submission('https://github.com/atlas-demo/harbor'));
    await h.coordinator(docker(), { publishReserveMs: 10_000 }).runOnce();
    const row = await h.job(job.jobId);
    expect(row.state).toBe('READY');
    expect(row.metrics.isolation).toBe('container');
    expect(row.warnings).toEqual([]);
    expect(row.counts).toMatchObject({ filesIncluded: 26, framesCompleted: 12 });
    const opened = await h.publications.manifest(row.analysis_id);
    expect(opened.frames).toHaveLength(12);
    expect(await leftovers(job.jobId)).toBe('');
  }, 240_000);

  it('never executes repository scripts, hooks, plugins, filters or submodule URLs (sentinel gate)', async () => {
    const seen: string[] = [];
    const inspect = (dir: string) => seen.push(...walk(dir).filter((f) => path.basename(f).startsWith('sentinel')));
    const scripted = new ScriptedRunners(docker(), {
      acquire: async (request, run) => {
        const result = await run();
        inspect(request.acquiredDir);
        return result;
      },
      analyze: async (request, run) => {
        const result = await run();
        inspect(request.acquiredDir);
        inspect(request.outDir);
        return result;
      },
    });
    const job = await h.submit(submission('https://github.com/atlas-demo/trap'));
    await h.coordinator(scripted, { publishReserveMs: 10_000 }).runOnce();
    const row = await h.job(job.jobId);
    expect(['READY', 'PARTIAL']).toContain(row.state);
    expect(scripted.analyses.length).toBeGreaterThan(0);
    expect(seen).toEqual([]);
    expect(readdirSync(sentinelDir).filter((f) => f.startsWith('sentinel'))).toEqual([]);
    expect(readdirSync(remoteSentinels).filter((f) => f.startsWith('sentinel'))).toEqual([]);
    const manifest = await h.publications.manifest(row.analysis_id);
    expect(manifest.coverage.head.includedFiles).toBeGreaterThan(5);
  }, 240_000);

  it('analysis cannot lazily fetch a missing blob: it reports missing objects with no network', async () => {
    runGit(demo.dir, ['config', 'uploadpack.allowFilter', 'true']);
    shareReadOnly(demo.dir);
    const jobDir = mkdtempSync(path.join(h.workRoot, 'partial-'));
    const acquiredDir = path.join(jobDir, 'acquired');
    mkdirSync(acquiredDir);
    const acquired = await acquireGithubCommit({ owner: 'atlas-demo', name: 'harbor' }, demo.commits.at(-1)!, {
      depth: 1, maxBytes: 64 * 1024 * 1024, timeoutMs: 60_000, filter: 'blob:none', fixtureRemote: demo.dir, scratchDir: path.join(acquiredDir, 'git'),
    });
    const objects = path.join(acquiredDir, 'git', 'meta.git', 'objects');
    const before = walk(objects).map((f) => `${path.relative(objects, f)}:${statSync(f).size}`).sort();
    const outDir = path.join(jobDir, 'out');
    mkdirSync(outDir);
    const result = await docker().analyze({
      jobId: `job_${'a'.repeat(32)}`,
      acquiredDir,
      outDir,
      spec: { commitOid: demo.commits.at(-1)!, objectFormat: 'sha1', repository: { numericId: '737373', owner: 'atlas-demo', name: 'harbor' }, history: false, checkpoint: false, deadlineMs: 60_000 },
      deadlineMs: 90_000,
      signal: new AbortController().signal,
      onProgress: () => {},
    });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ code: 'LOCAL_OBJECT_MISSING' });
    expect(walk(objects).map((f) => `${path.relative(objects, f)}:${statSync(f).size}`).sort()).toEqual(before);
    await acquired.git.dispose();
    rmSync(jobDir, { recursive: true, force: true });
  }, 120_000);

  it('the acquisition network reaches nothing but the broker, and the broker refuses other hosts', async () => {
    const runners = docker();
    const probe = `
      const net=require('node:net');
      const tcp=(host,port)=>new Promise(r=>{const s=net.connect(port,host);s.setTimeout(1500);s.on('connect',()=>{s.destroy();r('open')});s.on('error',e=>r(e.code||'error'));s.on('timeout',()=>{s.destroy();r('timeout')});});
      const connect=(target)=>new Promise(r=>{const s=net.connect(3128,'atlas-broker');s.setTimeout(5000);s.on('connect',()=>s.write('CONNECT '+target+' HTTP/1.1\\r\\nHost: '+target+'\\r\\n\\r\\n'));s.on('data',d=>{r(d.toString().split('\\r\\n')[0]);s.destroy()});s.on('error',e=>r(e.code||'error'));s.on('timeout',()=>{s.destroy();r('timeout')});});
      (async()=>{for(let i=0;i<50&&await tcp('atlas-broker',3128)!=='open';i++)await new Promise(r=>setTimeout(r,200));
      console.log(JSON.stringify({direct:await tcp('1.1.1.1',443),metadata:await tcp('169.254.169.254',80),broker:await tcp('atlas-broker',3128),evil:await connect('example.com:443'),ip:await connect('140.82.112.3:443'),port:await connect('github.com:22')}));})();`;
    const output: Buffer[] = [];
    const { result } = await runners.withEgress({ jobId: `job_${'b'.repeat(32)}`, maxBytes: 1024 * 1024, signal: new AbortController().signal, deadlineMs: 60_000, broker: true }, (network) =>
      runContainer(runtime(), { role: 'acquisition', limits: { memoryBytes: 128 * 1024 * 1024, scratchBytes: 8 * 1024 * 1024, cpus: 1, pids: 16 }, network: { kind: 'internal', name: network }, mounts: [], command: ['node', '-e', probe] }, { deadlineMs: 60_000, onStdout: (c) => output.push(c) }),
    );
    expect(result.exitCode).toBe(0);
    const witness = JSON.parse(Buffer.concat(output).toString('utf8'));
    expect(witness.direct).not.toBe('open');
    expect(witness.metadata).not.toBe('open');
    expect(witness.broker).toBe('open');
    expect(witness.evil).toMatch(/^HTTP\/1\.1 403/);
    expect(witness.ip).toMatch(/^HTTP\/1\.1 403/);
    expect(witness.port).toMatch(/^HTTP\/1\.1 403/);
    expect(await leftovers(`job_${'b'.repeat(32)}`)).toBe('');
  }, 120_000);

  it.runIf(process.env['ATLAS_NETWORK_TESTS'] === '1')('acquires a public GitHub commit only through the broker, with network bytes counted', async () => {
    const runners = new DockerStageRunners(runtime(), { kind: 'github' });
    const acquiredDir = mkdtempSync(path.join(h.workRoot, 'live-'));
    const { chmodSync } = await import('node:fs');
    chmodSync(acquiredDir, 0o777);
    const outcome = await runners.acquire({
      jobId: `job_${'c'.repeat(32)}`, acquiredDir, owner: 'octocat', name: 'Hello-World', numericId: '1296269',
      commitOid: '7fd1a60b01f91b314f59955a4e4d4e80d8edf11d', depth: 1, maxNetworkBytes: 16 * 1024 * 1024, deadlineMs: 90_000, signal: new AbortController().signal,
    });
    expect(outcome.networkBytes).toBeGreaterThan(1000);
    expect(outcome.bytesOnDisk).toBeGreaterThan(0);
    // The same acquisition with a budget below the transfer fails closed at the broker.
    const small = mkdtempSync(path.join(h.workRoot, 'live-small-'));
    chmodSync(small, 0o777);
    await expect(runners.acquire({
      jobId: `job_${'d'.repeat(32)}`, acquiredDir: small, owner: 'octocat', name: 'Spoon-Knife', numericId: '1300192',
      commitOid: 'd0dd1f61b33d64e29d8bc1372a94ef6a2fee76a9', depth: 1, maxNetworkBytes: 2048, deadlineMs: 90_000, signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'REPOSITORY_TOO_LARGE' });
    expect(await leftovers(`job_${'c'.repeat(32)}`)).toBe('');
    expect(await leftovers(`job_${'d'.repeat(32)}`)).toBe('');
  }, 240_000);
});

describe('sandbox frame protocol', () => {
  it('rejects unknown frames, bad names, duplicates and oversized messages', () => {
    const encode = (type: number, payload: Buffer) => {
      const header = Buffer.alloc(5);
      header[0] = type;
      header.writeUInt32BE(payload.length, 1);
      return Buffer.concat([header, payload]);
    };
    const file = (name: string, bytes = Buffer.from('x')) => {
      const n = Buffer.from(name);
      return encode(FRAME.FILE, Buffer.concat([Buffer.from([n.length >> 8, n.length & 0xff]), n, bytes]));
    };
    expect(() => new FrameDecoder().push(encode(9, Buffer.from('{}')))).toThrow('Unknown');
    for (const name of ['../manifest.json', 'graphs/x.json.gz', '/etc/passwd', 'manifest.json\0', 'layout/layout.json']) expect(() => new FrameDecoder().push(file(name)), name).toThrow('Invalid artifact file name');
    const decoder = new FrameDecoder();
    decoder.push(file('manifest.json'));
    expect(() => decoder.push(file('manifest.json'))).toThrow('Duplicate');
    const huge = Buffer.alloc(5);
    huge[0] = FRAME.PROGRESS;
    huge.writeUInt32BE(10 * 1024 * 1024, 1);
    expect(() => new FrameDecoder().push(huge)).toThrow('limit');
    const partial = new FrameDecoder();
    partial.push(encode(FRAME.RESULT, Buffer.from('{"ok":true}')).subarray(0, 8));
    expect(() => partial.end()).toThrow('inside a frame');
    // Frames split across arbitrary chunk boundaries decode identically.
    const whole = Buffer.concat([file('history/history.json.gz', Buffer.alloc(70_000, 3)), encode(FRAME.RESULT, Buffer.from('{"ok":true,"status":"complete"}'))]);
    const split = new FrameDecoder();
    const frames = [];
    for (let i = 0; i < whole.length; i += 997) frames.push(...split.push(whole.subarray(i, i + 997)));
    split.end();
    expect(frames.map((f) => f.type)).toEqual([FRAME.FILE, FRAME.RESULT]);
    expect(frames[0]!.type === FRAME.FILE && frames[0]!.bytes.length).toBe(70_000);
  });
});
