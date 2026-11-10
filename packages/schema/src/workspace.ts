import { z } from 'zod';
import { ArchitectureReviewSchema, ARCHITECTURE_LIMITS } from './architecture.js';
import { Hex64Schema } from './primitives.js';

export const WORKSPACE_LIMITS = Object.freeze({
  bytes: 10 * 1024 * 1024,
  decisions: ARCHITECTURE_LIMITS.rows,
  revisions: 1_000_000,
});
export const WorkspaceDecisionStateSchema = z.enum(['needs-review', 'acknowledged', 'deferred']);
export const WorkspaceOwnerSchema = z.enum(['unassigned', 'maintainers', 'architecture-review', 'security-review']);
export const WorkspaceDecisionSchema = z.strictObject({
  issueId: z.string().regex(/^ar_[0-9a-f]{64}$/),
  reportSha256: Hex64Schema,
  state: WorkspaceDecisionStateSchema,
  owner: WorkspaceOwnerSchema,
  changedRevision: z.number().int().min(1).max(WORKSPACE_LIMITS.revisions),
});
export const ReviewWorkspaceSchema = z.strictObject({
  format: z.literal('atlas.local-review-workspace/1'),
  id: z.string().regex(/^ws_[0-9a-f]{64}$/),
  reportSha256: Hex64Schema,
  report: ArchitectureReviewSchema,
  revision: z.number().int().min(0).max(WORKSPACE_LIMITS.revisions),
  decisions: z.array(WorkspaceDecisionSchema).max(WORKSPACE_LIMITS.decisions),
});
export type WorkspaceDecision = z.infer<typeof WorkspaceDecisionSchema>;
export type WorkspaceDecisionState = z.infer<typeof WorkspaceDecisionStateSchema>;
export type WorkspaceOwner = z.infer<typeof WorkspaceOwnerSchema>;
export type ReviewWorkspace = z.infer<typeof ReviewWorkspaceSchema>;
