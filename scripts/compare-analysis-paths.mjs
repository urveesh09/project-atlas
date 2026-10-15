#!/usr/bin/env node
/**
 * Path-level comparison of two analyzer builds (ADR-060), for deliberate version changes.
 *
 *   node scripts/compare-analysis-paths.mjs <baseline-root> [--limit N]
 *
 * <baseline-root> is another checkout of this repository with its packages built, for
 * example a `git worktree` of main. The Harbor fixture and the acquired pinned corpus
 * (`validate-real-repositories.mjs --acquire`) are analyzed offline by both builds.
 *
 * Hash IDs include the analyzer version, so a version bump changes every ID byte. Each ID is
 * rewritten to the path or name it stands for, and three ID-ordered choices are named by
 * content instead: a cycle's ID, fingerprint and witness (which starts at its lowest node
 * ID), and the observation a fan-in finding cites for each consumer edge. Everything else
 * is compared exactly. Exit status 1 means the builds differ.
 */
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baselineRoot = process.argv[2];
const limitAt = process.argv.indexOf('--limit');
const limit = limitAt < 0 ? 60 : Number(process.argv[limitAt + 1]);
if (!baselineRoot) throw new Error('Usage: compare-analysis-paths.mjs <baseline-root> [--limit N]');

const corpus = JSON.parse(await readFile(path.join(root, 'docs/release/repository-corpus.json'), 'utf8'));
const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const canon = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));
/** Fields that name versions, or hash them, rather than describe the repository. */
const VERSIONED = new Set(['analyzerVersion', 'schemaVersion', 'artifactVersion', 'analysisKey', 'analyzer', 'analysisId', 'createdAt', 'optionsDigest', 'historyId', 'layoutId']);

function normalize(draft) {
  const ids = new Map();
  const map = (v) => {
    if (typeof v === 'string') return ids.get(v) ?? v;
    if (Array.isArray(v)) return v.map(map).sort((a, b) => (canon(a) < canon(b) ? -1 : canon(a) > canon(b) ? 1 : 0));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).flatMap(([k, x]) => (VERSIONED.has(k) ? [] : [[k, map(x)]])));
    return v;
  };
  const graphs = draft.graphs.map((g) => ({ ...g }));
  for (const g of graphs) {
    const at = g.commitOid.slice(0, 12);
    ids.set(g.snapshotId, `snapshot@${at}`);
    for (const n of g.nodes) {
      const key = n.kind === 'repository' ? '' : n.kind === 'external-package' ? `${n.ecosystem}:${n.packageName}` : n.kind === 'builtin' ? `${n.runtime ?? 'node'}:${n.moduleName}` : n.path;
      ids.set(n.id, `${n.kind}:${key}@${at}`);
    }
  }
  for (const g of graphs) {
    const members = new Map();
    for (const m of g.metrics) if (m.sccId) (members.get(m.sccId) ?? members.set(m.sccId, []).get(m.sccId)).push(ids.get(m.nodeId));
    for (const [scc, list] of members) ids.set(scc, `scc:${list.length}:${sha(list.sort().join('\n'))}`);
    const obs = new Map(g.importObservations.map((o) => [o.id, o]));
    const edgeOf = (id) => `edge ${ids.get(obs.get(id).sourceId)} > ${ids.get(obs.get(id).targetId)} ${obs.get(id).kind}`;
    g.diagnostics = g.diagnostics.map((d) =>
      d.ruleId === 'ATLAS_STATIC_CYCLE' ? { ...d, fingerprint: 'by members', evidenceIds: ['witness'], parameters: { ...d.parameters, witness: 'witness' } }
      : d.ruleId === 'ATLAS_HIGH_FAN_IN' ? { ...d, evidenceIds: d.evidenceIds.map(edgeOf) } : d);
  }
  // Content-derived names for rows whose IDs hash the snapshot; edges cite observations.
  for (const table of ['importObservations', 'edges', 'diagnostics'])
    for (const g of graphs) for (const r of g[table]) ids.set(r.id, `${table}:${sha(canon(map({ ...r, id: null })))}`);
  return map({ ...draft, graphs });
}

async function analyzeAll(buildRoot) {
  const load = (name, entry = 'index.js') => import(pathToFileURL(path.join(buildRoot, 'packages', name, 'dist', entry)).href);
  const { SafeGit, gitVersion, openLocalRepository, resolveLocalCommit } = await load('ingest');
  const { analyzeCommit, ANALYZER_VERSION } = await load('analyzer-core');
  const { hostedRepositoryId, localRepositoryId } = await load('schema');
  const { buildDemoRepository } = await load('test-fixtures');
  const version = await gitVersion();
  const out = {};
  const demo = buildDemoRepository();
  const opened = await openLocalRepository(demo.dir);
  try {
    const result = await analyzeCommit({
      git: opened.git, commitOid: await resolveLocalCommit(opened.repo, opened.git), gitVersion: version,
      repository: { repoId: localRepositoryId('3f2a9c4e-8b1d-4f6a-9c2e-7d5b1a0e4c3f'), displayName: 'harbor', sourceKind: 'local-git', remote: null, objectFormat: 'sha1' },
      now: () => new Date('2026-10-10T00:00:00.000Z'),
    });
    out.harbor = { status: result.status, summary: result.summary, draft: normalize(result.draft) };
  } finally {
    await opened.git.dispose();
    demo.dispose();
  }
  for (const repo of corpus.repositories) {
    const key = `${repo.owner}-${repo.name}`;
    const objectDirectory = path.join(root, '.atlas-tmp/release-corpus', key, 'git/meta.git/objects');
    const git = await SafeGit.create({ objectDirectory, objectFormat: 'sha1', network: { kind: 'offline' } });
    try {
      const result = await analyzeCommit({
        git, commitOid: repo.commit, gitVersion: version,
        repository: { repoId: hostedRepositoryId(repo.numericId), displayName: `${repo.owner}/${repo.name}`, sourceKind: 'public-github', remote: { host: 'github.com', owner: repo.owner, name: repo.name, numericId: repo.numericId }, objectFormat: 'sha1' },
      });
      out[key] = { status: result.status, summary: result.summary, draft: normalize(result.draft) };
    } finally {
      await git.dispose();
    }
  }
  console.log(`${buildRoot}: analyzer ${ANALYZER_VERSION}, ${Object.keys(out).length} repositories`);
  return out;
}

const before = await analyzeAll(path.resolve(baselineRoot));
const after = await analyzeAll(root);
let total = 0;
const show = (v) => { const s = JSON.stringify(v); return s === undefined ? 'absent' : s.length > 240 ? `${s.slice(0, 240)}…` : s; };
function walk(x, y, at, found) {
  if (canon(x) === canon(y)) return;
  if (x && y && typeof x === 'object' && typeof y === 'object' && Array.isArray(x) === Array.isArray(y)) {
    if (Array.isArray(x) && x.length !== y.length) {
      const sx = new Set(x.map(canon));
      const sy = new Set(y.map(canon));
      for (const e of sx) if (!sy.has(e)) found.push(`${at}: only before ${show(JSON.parse(e))}`);
      for (const e of sy) if (!sx.has(e)) found.push(`${at}: only after ${show(JSON.parse(e))}`);
      return;
    }
    for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) walk(x[k], y[k], `${at}.${k}`, found);
    return;
  }
  found.push(`${at}: ${show(x)} -> ${show(y)}`);
}
for (const repo of Object.keys(after)) {
  const found = [];
  walk(before[repo], after[repo], repo, found);
  total += found.length;
  console.log(`${repo}: ${found.length} difference${found.length === 1 ? '' : 's'}`);
  for (const line of found.slice(0, limit)) console.log(`  ${line}`);
}
process.exitCode = total === 0 ? 0 : 1;
