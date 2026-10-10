import { compareUtf8, repoBasename, type GraphSnapshot } from '@atlas/schema';

/**
 * Human search (plan §12.2): case-insensitive over paths, package names and bounded
 * declaration names. Ranking: exact match, then prefix, then substring; ties break by
 * path in canonical order. Pure and synchronous so it can run in a worker or the CLI.
 */
export interface SearchHit {
  nodeId: string;
  kind: 'file' | 'package' | 'directory';
  path: string;
  /** What matched: the path, the file name, a package name or a declaration. */
  match: { field: 'path' | 'name' | 'package' | 'declaration'; text: string };
  tier: 0 | 1 | 2;
}

interface Entry {
  nodeId: string;
  kind: SearchHit['kind'];
  path: string;
  fields: { field: SearchHit['match']['field']; text: string; lower: string }[];
}

export class SearchIndex {
  private readonly entries: Entry[] = [];

  constructor(snapshot: GraphSnapshot) {
    for (const node of snapshot.nodes) {
      if (node.kind === 'file') {
        const fields: Entry['fields'] = [
          { field: 'path', text: node.path, lower: node.path.toLowerCase() },
          { field: 'name', text: repoBasename(node.path), lower: repoBasename(node.path).toLowerCase() },
        ];
        for (const declaration of node.declarations) fields.push({ field: 'declaration', text: declaration.name, lower: declaration.name.toLowerCase() });
        this.entries.push({ nodeId: node.id, kind: 'file', path: node.path, fields });
      } else if (node.kind === 'package') {
        const fields: Entry['fields'] = [];
        if (node.packageName) fields.push({ field: 'package', text: node.packageName, lower: node.packageName.toLowerCase() });
        if (node.path) fields.push({ field: 'path', text: node.path, lower: node.path.toLowerCase() });
        if (fields.length > 0) this.entries.push({ nodeId: node.id, kind: 'package', path: node.path, fields });
      } else if (node.kind === 'directory') {
        this.entries.push({ nodeId: node.id, kind: 'directory', path: node.path, fields: [{ field: 'path', text: node.path, lower: node.path.toLowerCase() }] });
      }
    }
    this.entries.sort((a, b) => compareUtf8(a.path, b.path));
  }

  get size(): number {
    return this.entries.length;
  }

  search(query: string, limit = 50): SearchHit[] {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return [];
    const hits: SearchHit[] = [];
    for (const entry of this.entries) {
      let best: SearchHit | null = null;
      for (const field of entry.fields) {
        const tier = field.lower === q ? 0 : field.lower.startsWith(q) ? 1 : field.lower.includes(q) ? 2 : -1;
        if (tier < 0) continue;
        if (!best || tier < best.tier) best = { nodeId: entry.nodeId, kind: entry.kind, path: entry.path, match: { field: field.field, text: field.text }, tier: tier as 0 | 1 | 2 };
        if (tier === 0) break;
      }
      if (best) hits.push(best);
    }
    // Stable: entries are already in path order, so sorting by tier keeps the tie-break.
    hits.sort((a, b) => a.tier - b.tier || (a.kind === 'file' ? 0 : 1) - (b.kind === 'file' ? 0 : 1) || compareUtf8(a.path, b.path));
    return hits.slice(0, limit);
  }
}
