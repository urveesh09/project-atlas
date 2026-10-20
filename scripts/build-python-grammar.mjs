#!/usr/bin/env node
/**
 * Rebuilds the vendored Python grammar (ADR-080) from pinned inputs: upstream
 * tree-sitter-python v0.25.0, the 3.15 syntax patch in `packages/analyzer-py/grammar`,
 * tree-sitter CLI 0.25.9 (checked by SHA-256) and emscripten 4.0.4 (image digest). The
 * generator, upstream corpus tests and the WebAssembly build all run in one offline
 * container. Without `--install` the result must match the recorded hash.
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const grammarDir = path.join(root, 'packages', 'analyzer-py', 'grammar');
const PIN = {
  repository: 'https://github.com/tree-sitter/tree-sitter-python.git',
  commit: '293fdc02038ee2bf0e2e206711b69c90ac0d413f', // tag v0.25.0
  cli: 'https://github.com/tree-sitter/tree-sitter/releases/download/v0.25.9/tree-sitter-linux-x64.gz',
  cliSha256: '00ffe4a332a112b6fd7f47d20be61bf76cbf39856fa98c944de51c822d39bdfc',
  image: 'emscripten/emsdk:4.0.4@sha256:47d573d5a86379a06f850de200d69407e6baa2d2f9c19d9e156a67db57f80f2f',
};
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const run = (command, args, options = {}) => execFileSync(command, args, { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true, encoding: 'utf8', ...options });

const work = path.join(root, '.atlas-tmp', 'python-grammar-build', randomUUID());
mkdirSync(work, { recursive: true });
try {
  const source = path.join(work, 'src');
  run('git', ['init', '--quiet', source]);
  run('git', ['-C', source, 'fetch', '--quiet', '--depth=1', PIN.repository, PIN.commit]);
  // Exact upstream bytes on every OS: no line-ending conversion.
  run('git', ['-C', source, 'config', 'core.autocrlf', 'false']);
  run('git', ['-C', source, '-c', 'advice.detachedHead=false', 'checkout', '--quiet', 'FETCH_HEAD']);
  if (run('git', ['-C', source, 'rev-parse', 'HEAD']).trim() !== PIN.commit) throw new Error('Upstream checkout is not the pinned commit');
  run('git', ['-C', source, 'apply', '--whitespace=nowarn', path.join(grammarDir, 'python-3.15.patch')]);

  const response = await fetch(PIN.cli);
  if (!response.ok) throw new Error(`CLI download failed: HTTP ${response.status}`);
  const archive = Buffer.from(await response.arrayBuffer());
  if (sha256(archive) !== PIN.cliSha256) throw new Error(`CLI archive hash ${sha256(archive)} is not the pinned ${PIN.cliSha256}`);
  writeFileSync(path.join(work, 'tree-sitter'), gunzipSync(archive), { mode: 0o755 });

  // Build inside the container's own filesystem; copy only the result to the mount.
  const script = [
    'set -eu',
    'install -m755 /work/tree-sitter /usr/local/bin/tree-sitter',
    'cp -r /work/src /tmp/src && cd /tmp/src',
    'tree-sitter generate',
    'tree-sitter test',
    'tree-sitter build --wasm -o /tmp/src/out.wasm .',
    'cp /tmp/src/out.wasm /work/tree-sitter-python.wasm',
  ].join('\n');
  execFileSync('docker', ['run', '--rm', '--network=none', '--env', 'NO_COLOR=1', '--mount', `type=bind,source=${work},target=/work`, PIN.image, 'bash', '-c', script], { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });

  const built = readFileSync(path.join(work, 'tree-sitter-python.wasm'));
  const digest = sha256(built);
  console.log(`tree-sitter-python.wasm ${built.length} bytes, SHA-256 ${digest}`);
  if (process.argv.includes('--install')) {
    copyFileSync(path.join(work, 'tree-sitter-python.wasm'), path.join(grammarDir, 'tree-sitter-python.wasm'));
    console.log('Installed. Record the hash in grammar/README.md, src/parser.ts and the ADR.');
  } else {
    const vendored = sha256(readFileSync(path.join(grammarDir, 'tree-sitter-python.wasm')));
    if (digest !== vendored) throw new Error(`Rebuilt grammar ${digest} differs from the vendored ${vendored}`);
    console.log('Matches the vendored grammar.');
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
