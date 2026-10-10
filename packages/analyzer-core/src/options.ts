import { z } from 'zod';
import { CLI_OPTION_RANGES, LIMITS, RELEASE_PROFILE, canonicalJsonSha256 } from '@atlas/schema';
import { compileGlob } from './globs.js';

export const ANALYZER_VERSION = '0.1.0-dev';

/** Caller-facing analysis options. Limits can only be lowered (plan §4.2). */
export interface AnalysisOptions {
  exclude?: readonly string[];
  history?: { enabled: boolean; days?: number; commits?: number; snapshots?: number };
  limits?: Partial<Pick<EffectiveLimits, 'includedFiles' | 'sourceBlobBytes' | 'headDecodedSourceBytes' | 'treeEntries'>>;
}

export interface EffectiveLimits {
  treeEntries: number;
  includedFiles: number;
  sourceBlobBytes: number;
  headDecodedSourceBytes: number;
}

export interface NormalizedOptions {
  profile: typeof RELEASE_PROFILE;
  exclude: string[];
  history: { enabled: boolean; days: number; commits: number; snapshots: number };
  limits: EffectiveLimits;
}

export class OptionsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OptionsError';
  }
}

function inRange(name: string, value: number | undefined, range: { min: number; max: number }, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < range.min || value > range.max) throw new OptionsError(`${name} must be an integer from ${range.min} to ${range.max}`);
  return value;
}

function lowered(name: string, value: number | undefined, ceiling: number): number {
  if (value === undefined) return ceiling;
  if (!Number.isInteger(value) || value < 1 || value > ceiling) throw new OptionsError(`${name} may be lowered but not raised above ${ceiling}`);
  return value;
}

export function normalizeOptions(options: AnalysisOptions = {}): NormalizedOptions {
  const exclude = [...new Set(options.exclude ?? [])].sort();
  for (const pattern of exclude) if (!compileGlob(pattern)) throw new OptionsError(`Unsupported exclusion pattern: ${pattern}`);
  const history = options.history ?? { enabled: true };
  return {
    profile: RELEASE_PROFILE,
    exclude,
    history: {
      enabled: history.enabled,
      days: inRange('--history-days', history.days, CLI_OPTION_RANGES.historyDays, LIMITS.historyLookbackDays),
      commits: inRange('--history-commits', history.commits, CLI_OPTION_RANGES.historyCommits, LIMITS.firstParentCommits),
      snapshots: inRange('--snapshots', history.snapshots, CLI_OPTION_RANGES.snapshots, LIMITS.analyzedFrames),
    },
    limits: {
      treeEntries: lowered('treeEntries', options.limits?.treeEntries, LIMITS.treeEntriesPerSnapshot),
      includedFiles: lowered('includedFiles', options.limits?.includedFiles, LIMITS.includedFilesPerSnapshot),
      sourceBlobBytes: lowered('sourceBlobBytes', options.limits?.sourceBlobBytes, LIMITS.sourceBlobBytes),
      headDecodedSourceBytes: lowered('headDecodedSourceBytes', options.limits?.headDecodedSourceBytes, LIMITS.headDecodedSourceBytes),
    },
  };
}

/** Digest of everything that changes analysis output besides the commit and versions. */
export function optionsDigest(options: NormalizedOptions, repositoryConfigDigest: string | null): string {
  return canonicalJsonSha256({ ...options, repositoryConfigDigest, analyzerVersion: ANALYZER_VERSION });
}

/**
 * `atlas.config.json` (plan §8.5): versioned data only. It can add exclusions and
 * (from P3) layout display overrides. It cannot relax caps, run code or name URLs.
 */
export const AtlasConfigSchema = z.looseObject({
  version: z.literal(1),
  exclude: z.array(z.string().min(1).max(256)).max(256).optional(),
  layout: z.record(z.string(), z.json()).optional(),
});

export interface RepositoryConfig {
  exclude: string[];
  digest: string | null;
  warnings: { code: string; path: string | null }[];
}

export function parseRepositoryConfig(text: string | null): RepositoryConfig {
  if (text === null) return { exclude: [], digest: null, warnings: [] };
  const warnings: RepositoryConfig['warnings'] = [];
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { exclude: [], digest: null, warnings: [{ code: 'ATLAS_CONFIG_INVALID', path: 'atlas.config.json' }] };
  }
  const version = (json as { version?: unknown } | null)?.version;
  if (typeof version === 'number' && version !== 1) return { exclude: [], digest: null, warnings: [{ code: 'ATLAS_CONFIG_UNSUPPORTED_VERSION', path: 'atlas.config.json' }] };
  const parsed = AtlasConfigSchema.safeParse(json);
  if (!parsed.success) return { exclude: [], digest: null, warnings: [{ code: 'ATLAS_CONFIG_INVALID', path: 'atlas.config.json' }] };
  const known = new Set(['version', 'exclude', 'layout']);
  if (Object.keys(parsed.data).some((k) => !known.has(k))) warnings.push({ code: 'ATLAS_CONFIG_UNKNOWN_KEY', path: 'atlas.config.json' });
  if (parsed.data.layout !== undefined) warnings.push({ code: 'ATLAS_CONFIG_LAYOUT_DEFERRED', path: 'atlas.config.json' });
  const exclude: string[] = [];
  for (const pattern of parsed.data.exclude ?? []) {
    if (compileGlob(pattern)) exclude.push(pattern);
    else warnings.push({ code: 'ATLAS_CONFIG_PATTERN_UNSUPPORTED', path: 'atlas.config.json' });
  }
  return { exclude: [...new Set(exclude)].sort(), digest: canonicalJsonSha256({ exclude: [...new Set(exclude)].sort() }), warnings };
}
