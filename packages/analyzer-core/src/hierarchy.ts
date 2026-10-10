import { SnapshotFS, SnapshotResolver, type PackageManifest } from '@atlas/analyzer-ts';
import {
  compareAscii,
  compareUtf8,
  edgeId,
  isWithinRepoPath,
  nodeId,
  repoAncestors,
  repoBasename,
  repoDirname,
  type DeclaredRange,
  type GraphEdge,
  type GraphNode,
} from '@atlas/schema';
import type { Inventory } from './inventory.js';

/**
 * Package and directory hierarchy (task P1.3, plan §6.2). Workspace packages are top-level
 * districts under the repository; a synthetic root package (path '') owns unclaimed files.
 * Within a package the folder structure is preserved exactly. A directory and a package at
 * the same path are represented by the package alone.
 */
export interface HierarchyResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  warnings: { code: string; path: string | null }[];
  /** File path -> node ID, and lineage assignment input. */
  fileNodeIds: Map<string, string>;
  packageRoots: string[];
  resolver: SnapshotResolver;
}

export interface HierarchyInput {
  snapshotId: string;
  repoDisplayName: string;
  inventory: Inventory;
  lineageOf: (path: string) => string;
}

export function buildHierarchy(input: HierarchyInput): HierarchyResult {
  const { snapshotId: snap, inventory } = input;
  const fs = new SnapshotFS(
    inventory.files.map((f) => ({ path: f.path, text: f.text })),
    // Excluded and limit-omitted files exist in Git but not in the analysis: imports that
    // reach them become excluded-target observations, never dangling edges.
    [...inventory.excluded.flatMap((e) => (e.path === null ? [] : [e.path])), ...inventory.omitted],
  );
  const resolver = new SnapshotResolver(fs);
  const workspace = resolver.workspace;
  const warnings: HierarchyResult['warnings'] = [...workspace.warnings, ...resolver.projects.warnings];

  const nodes = new Map<string, GraphNode>();
  const add = (node: GraphNode) => nodes.set(node.id, node);

  const repositoryId = nodeId(snap, 'repository', '');
  add({ id: repositoryId, kind: 'repository', label: input.repoDisplayName, parentId: null, lineageId: null });

  // Packages: the root (real or synthetic) plus recognized workspace members.
  const rootManifest = workspace.manifests.find((m) => m.root === '') ?? null;
  const members = workspace.manifests.filter((m) => m.root !== '' && m.workspace);
  const packageByRoot = new Map<string, { id: string; manifest: PackageManifest | null }>();
  const addPackage = (root: string, manifest: PackageManifest | null) => {
    const id = nodeId(snap, 'package', root);
    packageByRoot.set(root, { id, manifest });
    add({
      id,
      kind: 'package',
      label: manifest?.name ?? (root === '' ? input.repoDisplayName : repoBasename(root)),
      parentId: repositoryId,
      lineageId: null,
      path: root,
      manifestPath: manifest?.manifestPath ?? null,
      packageName: manifest?.name ?? null,
      workspace: manifest?.workspace ?? false,
    });
  };
  addPackage('', rootManifest);
  for (const member of members) addPackage(member.root, member);
  const packageRoots = [...packageByRoot.keys()].sort((a, b) => b.length - a.length || compareUtf8(a, b));
  const owningPackage = (path: string) => packageRoots.find((root) => isWithinRepoPath(path, root))!;

  // Directories between each file and its package root.
  const containerId = (path: string): string => {
    const pkg = packageByRoot.get(path);
    if (pkg) return pkg.id;
    return nodeId(snap, 'directory', path);
  };
  const ensureDirectory = (path: string) => {
    if (path === '' || packageByRoot.has(path)) return;
    const id = nodeId(snap, 'directory', path);
    if (nodes.has(id)) return;
    add({ id, kind: 'directory', label: repoBasename(path), parentId: containerId(repoDirname(path)), lineageId: null, path });
  };

  const fileNodeIds = new Map<string, string>();
  for (const file of inventory.files) {
    const owner = owningPackage(file.path);
    for (const ancestor of repoAncestors(file.path)) {
      if (owner === '' || isWithinRepoPath(ancestor, owner)) {
        if (ancestor !== owner) ensureDirectory(ancestor);
      }
    }
    const id = nodeId(snap, 'file', file.path);
    fileNodeIds.set(file.path, id);
    add({
      id,
      kind: 'file',
      label: repoBasename(file.path),
      parentId: containerId(repoDirname(file.path)),
      lineageId: input.lineageOf(file.path),
      path: file.path,
      blobOid: file.blobOid,
      blobSha256: file.blobSha256,
      language: file.language,
      role: file.role,
      byteSize: file.byteSize,
      // Phase 1 is structural: parse candidates are recorded as skipped until P2.1.
      parseStatus: file.language !== null ? 'skipped' : 'unsupported',
      declarations: [],
      declarationsOmitted: 0,
    });
  }

  // Declared dependencies: package -> workspace package or external npm package.
  const edges = new Map<string, GraphEdge>();
  const externalRanges = new Map<string, DeclaredRange[]>();
  const declare = (sourceId: string, targetId: string, count: number) => {
    const id = edgeId(snap, sourceId, targetId, 'declares-package', 'exact');
    const existing = edges.get(id);
    edges.set(id, { id, sourceId, targetId, kind: 'declares-package', confidence: 'exact', observationCount: (existing?.observationCount ?? 0) + count, evidenceIds: [], evidenceOmitted: 0 });
  };
  for (const [, pkg] of [...packageByRoot].sort(([a], [b]) => compareUtf8(a, b))) {
    if (!pkg.manifest) continue;
    for (const [name, declarations] of [...pkg.manifest.dependencies].sort(([a], [b]) => compareUtf8(a, b))) {
      if (workspace.ambiguousNames.has(name)) {
        warnings.push({ code: 'AMBIGUOUS_WORKSPACE_DEPENDENCY', path: pkg.manifest.manifestPath });
        continue;
      }
      const internal = workspace.byName.get(name);
      if (internal && packageByRoot.has(internal.root)) {
        if (internal.root !== pkg.manifest.root) declare(pkg.id, packageByRoot.get(internal.root)!.id, declarations.length);
        continue;
      }
      const target = nodeId(snap, 'external-package', name);
      const ranges = externalRanges.get(name) ?? [];
      for (const d of declarations) ranges.push({ packageNodeId: pkg.id, field: d.field, range: d.range });
      externalRanges.set(name, ranges);
      declare(pkg.id, target, declarations.length);
    }
  }
  for (const [name, ranges] of externalRanges) {
    add({
      id: nodeId(snap, 'external-package', name),
      kind: 'external-package',
      label: name,
      parentId: null,
      lineageId: null,
      ecosystem: 'npm',
      packageName: name,
      declaredRanges: ranges.sort((a, b) => compareAscii(a.packageNodeId, b.packageNodeId) || compareAscii(a.field, b.field) || compareUtf8(a.range, b.range)),
    });
  }

  // Project references between packages are structural build relationships.
  for (const context of resolver.projects.contexts) {
    if (!context.configPath) continue;
    const source = packageByRoot.get(owningPackage(context.configPath))!;
    for (const reference of context.references) {
      const target = packageByRoot.get(owningPackage(reference))!;
      if (target.id === source.id) continue;
      const id = edgeId(snap, source.id, target.id, 'project-reference', 'exact');
      const existing = edges.get(id);
      edges.set(id, { id, sourceId: source.id, targetId: target.id, kind: 'project-reference', confidence: 'exact', observationCount: (existing?.observationCount ?? 0) + 1, evidenceIds: [], evidenceOmitted: 0 });
    }
  }

  // Assigning every parse candidate a context surfaces MULTIPLE_PROJECT_CONTEXTS.
  for (const file of inventory.files) if (file.supported) resolver.projects.contextFor(file.path);
  for (const warning of resolver.projects.warnings) if (!warnings.includes(warning)) warnings.push(warning);

  return {
    nodes: [...nodes.values()].sort((a, b) => compareAscii(a.id, b.id)),
    edges: [...edges.values()].sort((a, b) => compareAscii(a.id, b.id)),
    warnings,
    fileNodeIds,
    packageRoots,
    resolver,
  };
}
