import type { SnapshotResolver } from '@atlas/analyzer-ts';
import type { PythonResolver } from '@atlas/analyzer-py';
import type { SyntaxFacts as FileFacts } from './facts.js';
import { LIMITS, compareAscii, nodeId, observationId, utf8ByteLength, type DeclaredRange, type GraphNode, type ImportObservation } from '@atlas/schema';
import { factCacheKey, type FactCache } from './fact-cache.js';
import type { InventoryFile } from './inventory.js';
import type { ParserPool } from './parse-pool.js';

/**
 * Parse every supported file (cache first, then the bounded parser pool) and turn each
 * import into an ImportObservation with resolution provenance (tasks P2.1/P2.2).
 * Merge order is canonical, so parallel completion order never affects the output.
 */
export interface ParsedFiles {
  /** Path -> facts, for supported files only. */
  facts: Map<string, FileFacts>;
  cacheHits: number;
}

export async function parseSupportedFiles(
  files: readonly InventoryFile[],
  pool: ParserPool,
  cache: FactCache,
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<ParsedFiles> {
  const supported = files.filter((f) => f.supported && f.text !== null);
  const facts = new Map<string, FileFacts>();
  let done = 0;
  let cacheHits = 0;
  await Promise.all(
    supported.map(async (file) => {
      if (signal?.aborted) return;
      const key = file.blobSha256 ? factCacheKey(file.path, file.blobSha256) : null;
      const cached = key ? await cache.get(key) : null;
      let result: FileFacts;
      if (cached) {
        cacheHits++;
        result = cached;
      } else {
        result = await pool.parse(file.path, file.text!);
        if (key) await cache.set(key, result);
      }
      facts.set(file.path, result);
      onProgress?.(++done, supported.length);
    }),
  );
  return { facts, cacheHits };
}

export interface ObservationBuild {
  observations: ImportObservation[];
  /** Perimeter nodes discovered through imports (undeclared externals and built-ins). */
  perimeterNodes: GraphNode[];
}

export function buildObservations(input: {
  snapshotId: string;
  facts: Map<string, FileFacts>;
  resolver: SnapshotResolver;
  /** Python resolution (ADR-060); null when the snapshot has no Python. */
  pythonResolver?: PythonResolver | null;
  fileNodeIds: Map<string, string>;
  /** External package nodes already created from manifests (`name`, or `pypi:name` for Python). */
  declaredExternals: Map<string, GraphNode>;
}): ObservationBuild {
  const { snapshotId: snap, resolver, fileNodeIds } = input;
  const observations: ImportObservation[] = [];
  const perimeter = new Map<string, GraphNode>();
  const paths = [...input.facts.keys()].sort();
  for (const path of paths) {
    const facts = input.facts.get(path)!;
    const sourceId = fileNodeIds.get(path);
    if (!sourceId || facts.parseStatus !== 'parsed') continue;
    if (facts.language === 'python') {
      if (input.pythonResolver) for (const imp of facts.imports) for (const r of input.pythonResolver.resolveAll(path, imp)) observations.push(pythonObservation(snap, sourceId, r));
      continue;
    }
    for (const imp of facts.imports) {
      let resolution = resolver.resolve(path, imp);
      let specifier = imp.specifier;
      // Specifiers are repository metadata with a bounded size (plan §6.4).
      if (specifier !== null && utf8ByteLength(specifier) > LIMITS.labelBytes) {
        specifier = null;
        resolution = { ...resolution, status: 'unsupported', targetPath: null, externalName: null, confidence: null, reasonCode: 'SPECIFIER_TOO_LONG' };
      }
      let targetId: string | null = null;
      let status = resolution.status;
      let reasonCode = resolution.reasonCode;
      let confidence = resolution.confidence;
      if (status === 'resolved-internal') {
        targetId = fileNodeIds.get(resolution.targetPath!) ?? null;
        if (targetId === null) {
          // Resolved to a committed file that is outside the analyzed set.
          status = 'excluded-target';
          reasonCode = 'TARGET_EXCLUDED';
          confidence = null;
        }
      } else if (status === 'resolved-external') {
        const name = resolution.externalName!;
        targetId = nodeId(snap, 'external-package', name);
        if (!input.declaredExternals.has(name) && !perimeter.has(targetId)) {
          perimeter.set(targetId, { id: targetId, kind: 'external-package', label: name, parentId: null, lineageId: null, ecosystem: 'npm', packageName: name, declaredRanges: [] as DeclaredRange[] });
        }
      } else if (status === 'builtin') {
        const name = resolution.externalName!;
        targetId = nodeId(snap, 'builtin', name);
        if (!perimeter.has(targetId)) perimeter.set(targetId, { id: targetId, kind: 'builtin', label: `node:${name}`, parentId: null, lineageId: null, moduleName: name });
      }
      observations.push({
        id: observationId(snap, sourceId, resolution.kind, imp.range, specifier),
        sourceId,
        kind: resolution.kind,
        specifier,
        range: imp.range,
        status,
        targetId,
        reasonCode: status === 'resolved-internal' || status === 'resolved-external' || status === 'builtin' ? reasonCode : (reasonCode ?? 'UNRESOLVED'),
        resolverMode: resolution.resolverMode,
        confidence: status === 'resolved-internal' || status === 'resolved-external' || status === 'builtin' ? confidence : null,
      });
    }
  }
  // Two statements can share a range only when one statement splits into value and type
  // observations, which differ by kind; IDs are therefore unique. Sort canonically.
  observations.sort((a, b) => compareAscii(a.id, b.id));
  return { observations, perimeterNodes: [...perimeter.values()] };

  /** One Python resolution as an observation, adding PyPI and standard-library perimeter nodes. */
  function pythonObservation(snapId: string, sourceId: string, r: ReturnType<PythonResolver['resolveAll']>[number]): ImportObservation {
    let specifier = r.specifier;
    let status: ImportObservation['status'] = r.status;
    let reasonCode = r.reasonCode;
    let confidence = r.confidence;
    let targetId: string | null = null;
    if (specifier !== null && utf8ByteLength(specifier) > LIMITS.labelBytes) {
      specifier = null;
      status = 'unsupported';
      reasonCode = 'SPECIFIER_TOO_LONG';
      confidence = null;
    } else if (status === 'resolved-internal') {
      targetId = fileNodeIds.get(r.targetPath!) ?? null;
      if (targetId === null) {
        status = 'excluded-target';
        reasonCode = 'TARGET_EXCLUDED';
        confidence = null;
      }
    } else if (status === 'resolved-external') {
      const name = r.externalName!;
      targetId = nodeId(snapId, 'external-package', `pypi:${name}`);
      if (!input.declaredExternals.has(`pypi:${name}`) && !perimeter.has(targetId)) {
        perimeter.set(targetId, { id: targetId, kind: 'external-package', label: name, parentId: null, lineageId: null, ecosystem: 'pypi', packageName: name, declaredRanges: [] as DeclaredRange[] });
      }
    } else if (status === 'builtin') {
      const name = r.externalName!;
      targetId = nodeId(snapId, 'builtin', `python:${name}`);
      if (!perimeter.has(targetId)) perimeter.set(targetId, { id: targetId, kind: 'builtin', label: name, parentId: null, lineageId: null, moduleName: name, runtime: 'python' });
    }
    const resolved = status === 'resolved-internal' || status === 'resolved-external' || status === 'builtin';
    return {
      id: observationId(snapId, sourceId, r.kind, r.range, specifier),
      sourceId,
      kind: r.kind,
      specifier,
      range: r.range,
      status,
      targetId,
      reasonCode: resolved ? reasonCode : (reasonCode ?? 'UNRESOLVED'),
      resolverMode: r.resolverMode,
      confidence: resolved ? confidence : null,
    };
  }
}
