import { z } from 'zod';
import { GitOidSchema, Hex64Schema, RepoPathSchema } from './primitives.js';
import { QualityReportSchema, QualityRuleSchema } from './quality.js';

export const SCAN_LIMITS = {
  bytes: 8 * 1024 * 1024,
  scopeFiles: 10_000,
  policyBytes: 64 * 1024,
  rootBytes: 2 * 1024 * 1024,
  verifierBytes: 2 * 1024 * 1024,
  timeoutMs: 20_000,
} as const;
export const RuffProfileSchema = z.strictObject({
  format: z.literal('atlas.ruff-profile/1'),
  isolated: z.literal(true),
  ignoreNoqa: z.literal(true),
  respectGitignore: z.literal(false),
  forceExclude: z.literal(false),
  targetVersion: z.string().regex(/^py3(?:[89]|1[0-5])$/),
  rules: z.array(QualityRuleSchema).min(1).max(1024),
});
export const ScanScopeSchema = z.strictObject({
  format: z.literal('atlas.scan-scope/1'),
  files: z.array(z.strictObject({ path: RepoPathSchema, blobOid: GitOidSchema })).max(SCAN_LIMITS.scopeFiles),
});
export const ScanEvidenceSchema = z.strictObject({
  format: z.literal('atlas.scan/1'),
  report: QualityReportSchema,
  profile: RuffProfileSchema,
  profileSha256: Hex64Schema,
  scope: ScanScopeSchema,
  execution: z.strictObject({
    declaration: z.literal('producer-asserted'),
    completed: z.literal(true),
    exitCode: z.union([z.literal(0), z.literal(1)]),
  }),
});
export const ScanTrustPolicySchema = z.strictObject({
  format: z.literal('atlas.scan-trust/1'),
  repository: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/),
  workflow: z.string().regex(/^\.github\/workflows\/[A-Za-z0-9][A-Za-z0-9._-]{0,79}\.ya?ml$/),
  workflowCommit: z.string().regex(/^[0-9a-f]{40}$/),
  sourceCommit: z.string().regex(/^[0-9a-f]{40}$/),
  sourceRef: z
    .string()
    .regex(/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/)
    .refine(
      (s) => !s.includes('..') && !s.includes('//') && !s.endsWith('/') && !s.endsWith('.') && !s.endsWith('.lock'),
    ),
  trustedRootSha256: Hex64Schema,
});
export type RuffProfile = z.infer<typeof RuffProfileSchema>;
export type ScanScope = z.infer<typeof ScanScopeSchema>;
export type ScanEvidence = z.infer<typeof ScanEvidenceSchema>;
export type ScanTrustPolicy = z.infer<typeof ScanTrustPolicySchema>;
