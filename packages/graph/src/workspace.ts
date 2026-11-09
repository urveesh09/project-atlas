import {
  ReviewWorkspaceSchema, WorkspaceDecisionStateSchema, WorkspaceOwnerSchema, WORKSPACE_LIMITS, ARCHITECTURE_LIMITS,
  canonicalJson, canonicalJsonSha256, hashFields, compareUtf8, utf8ByteLength,
  type ArchitectureReview, type ReviewWorkspace, type WorkspaceDecisionState, type WorkspaceOwner,
} from '@atlas/schema';
import { parseBoundedReviewJson } from './architecture.js';
import { QualityImportError } from './quality.js';

function fail(message: string): never { throw new QualityImportError(message); }

/** Validates storage structure and bindings; artifact recomputation is a separate required admission step. */
export function parseReviewWorkspace(text: string): ReviewWorkspace {
  const parsed = ReviewWorkspaceSchema.safeParse(parseBoundedReviewJson(text, WORKSPACE_LIMITS.bytes));
  if (!parsed.success) fail('Invalid or unsupported local review workspace.');
  const workspace = parsed.data;
  if (utf8ByteLength(canonicalJson(workspace.report)) + 1 > ARCHITECTURE_LIMITS.reportBytes) fail('Workspace report exceeds the architecture review byte limit.');
  if (workspace.reportSha256 !== canonicalJsonSha256(workspace.report)
    || workspace.id !== `ws_${hashFields('atlas.local-workspace/1', [workspace.reportSha256])}`) {
    fail('Workspace report digest or identity does not reconcile.');
  }
  const issues = new Set(workspace.report.rows.map(row => row.id));
  const revisions = new Set<number>();
  for (let i = 0; i < workspace.decisions.length; i++) {
    const decision = workspace.decisions[i]!;
    if (decision.reportSha256 !== workspace.reportSha256 || !issues.has(decision.issueId)
      || decision.changedRevision > workspace.revision
      || revisions.has(decision.changedRevision)
      || (i > 0 && compareUtf8(workspace.decisions[i - 1]!.issueId, decision.issueId) >= 0)) {
      fail('Workspace decisions do not match the exact retained report or revision.');
    }
    revisions.add(decision.changedRevision);
  }
  if (workspace.revision > 0 && !revisions.has(workspace.revision)) fail('Workspace revision must match its latest decision.');
  return workspace;
}

/** Caller first recomputes this review against the original matching artifact frames. */
export function createReviewWorkspace(report: ArchitectureReview): ReviewWorkspace {
  const reportSha256 = canonicalJsonSha256(report);
  return parseReviewWorkspace(canonicalJson({
    format: 'atlas.local-review-workspace/1',
    id: `ws_${hashFields('atlas.local-workspace/1', [reportSha256])}`,
    reportSha256, report, revision: 0, decisions: [],
  }));
}

export function decideReviewWorkspace(
  workspace: ReviewWorkspace,
  expectedRevision: number,
  issueId: string,
  state: WorkspaceDecisionState,
  owner: WorkspaceOwner,
): ReviewWorkspace {
  const current = parseReviewWorkspace(canonicalJson(workspace));
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== current.revision) fail('Workspace revision changed. Inspect it before making another decision.');
  if (current.revision >= WORKSPACE_LIMITS.revisions) fail('Workspace revision limit reached. Export and retain the workspace; no edit was applied.');
  if (!WorkspaceDecisionStateSchema.safeParse(state).success || !WorkspaceOwnerSchema.safeParse(owner).success) fail('Choose a documented decision state and ownership queue.');
  if (!current.report.rows.some(row => row.id === issueId)) fail('Decision issue is not retained in this exact review.');
  const revision = current.revision + 1;
  const decisions = current.decisions.filter(decision => decision.issueId !== issueId);
  decisions.push({ issueId, reportSha256: current.reportSha256, state, owner, changedRevision: revision });
  decisions.sort((a, b) => compareUtf8(a.issueId, b.issueId));
  const updated = parseReviewWorkspace(canonicalJson({ ...current, revision, decisions }));
  if (utf8ByteLength(canonicalJson(updated)) + 1 > WORKSPACE_LIMITS.bytes) fail('Workspace exceeds its byte limit.');
  return updated;
}
