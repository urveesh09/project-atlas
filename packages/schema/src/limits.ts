/**
 * The fixed V0.1 release profile (plan §4.2). Hosted limits are hard; the CLI may lower
 * limits but never raise them. Changing a value requires an ADR and re-run capacity gates.
 */
export const MIB = 1_048_576;
export const GIB = 1_073_741_824;

export const LIMITS = Object.freeze({
  treeEntriesPerSnapshot: 100_000,
  includedFilesPerSnapshot: 10_000,
  historicalUnionLineages: 20_000,
  sourceBlobBytes: 1 * MIB,
  headDecodedSourceBytes: 64 * MIB,
  historyDistinctSourceBytes: 256 * MIB,
  acquisitionNetworkBytes: 256 * MIB,
  jobScratchBytes: 1 * GIB,
  workerMemoryBytes: 2 * GIB,
  sourceDependencyEdgesPerSnapshot: 100_000,
  dependencyEvidenceRowsPerSnapshot: 250_000,
  declarationsPerFile: 100,
  historyLookbackDays: 90,
  firstParentCommits: 200,
  analyzedFrames: 12,
  coChangeMaxFilesPerCommit: 50,
  coChangeMinTogether: 3,
  coChangeMaxPartners: 20,
  configInheritanceDepth: 16,
  configFiles: 256,
  configFileBytes: 1 * MIB,
  workerDeadlineMs: 300_000,
  perFileParseDeadlineMs: 2_000,
  directoryNesting: 64,
  artifactUncompressedBytes: 128 * MIB,
  artifactCompressedBytes: 20 * MIB,
  renameSimilarityPercent: 80,
  renameCandidateLimit: 1_000,
  diagnosticsPerFrame: 50_000,
  pathBytes: 4_096,
  labelBytes: 1_024,
  diagnosticParameterBytes: 1_024,
  diagnosticParameters: 32,
  coverageWarnings: 10_000,
  selectedFileEdgesRendered: 200,
  externalTerminalsRendered: 50,
  visibleDomLabels: 100,
  reachDefaultDepth: 2,
  reachMaxDepth: 5,
  reachMaxVisited: 2_000,
  shareFragmentBytes: 4_096,
  apiRequestBodyBytes: 16 * 1024,
  publicationTtlDays: 7,
} as const);

export type LimitName = keyof typeof LIMITS;

/** CLI-adjustable history options and their inclusive ranges (plan §14.1). */
export const CLI_OPTION_RANGES = Object.freeze({
  snapshots: { min: 1, max: LIMITS.analyzedFrames },
  historyDays: { min: 1, max: LIMITS.historyLookbackDays },
  historyCommits: { min: 1, max: LIMITS.firstParentCommits },
} as const);
