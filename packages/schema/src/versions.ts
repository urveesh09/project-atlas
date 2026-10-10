/**
 * Contract versions (plan §6.1). These are independent of the application version.
 * Unknown major versions are rejected by every consumer.
 */
export const GRAPH_SCHEMA_VERSION = 'atlas.graph/1.0.0' as const;
export const LAYOUT_VERSION = 'atlas.layout/1.1.0' as const;
export const ARTIFACT_VERSION = 'atlas.artifact/1.2.0' as const;
export const METRIC_DEFINITION_VERSION = 'atlas.metrics/1' as const;
export const RELEASE_PROFILE = 'v0.1-default' as const;

export interface ParsedContractVersion {
  family: string;
  major: number;
  minor: number;
  patch: number;
}

const CONTRACT_VERSION = /^(atlas\.[a-z]+)\/(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})$/;

export function parseContractVersion(value: string): ParsedContractVersion | null {
  const match = CONTRACT_VERSION.exec(value);
  if (!match) return null;
  return {
    family: match[1]!,
    major: Number(match[2]),
    minor: Number(match[3]),
    patch: Number(match[4]),
  };
}

/** True when `candidate` belongs to the same family and major version as `supported`. */
export function isCompatibleContractVersion(candidate: string, supported: string): boolean {
  const a = parseContractVersion(candidate);
  const b = parseContractVersion(supported);
  return a !== null && b !== null && a.family === b.family && a.major === b.major;
}
