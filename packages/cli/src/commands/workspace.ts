import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { openArtifactDirectory } from '@atlas/artifact/node';
import {
  canonicalJson, ArchitectureReviewSchema, WorkspaceDecisionStateSchema, WorkspaceOwnerSchema, WORKSPACE_LIMITS, ARCHITECTURE_LIMITS,
  type ArchitectureReview, type ReviewWorkspace,
} from '@atlas/schema';
import {
  createReviewWorkspace, decideReviewWorkspace, parseReviewWorkspace,
  validateArchitectureReview, parseBoundedReviewJson, architectureReasonLabel, QualityImportError,
} from '@atlas/graph';
import { EXIT, UsageError, type CommandContext } from '../context.js';
import { initializeWorkspace, loadWorkspace, updateWorkspace, exportWorkspace, readWorkspaceFile, assertWorkspaceOutside } from '../workspace-store.js';

export interface WorkspaceArguments {
  action: 'init' | 'import' | 'inspect' | 'decide' | 'export';
  input: string;
  artifact: string;
  out?: string;
  issue?: string;
  state?: string;
  owner?: string;
  expectedRevision?: string;
}

export async function workspaceCommand(ctx: CommandContext, args: WorkspaceArguments): Promise<number> {
  try {
    if (ctx.io.signal.aborted) return EXIT.cancelled;
    const at = (value: string) => path.resolve(ctx.io.cwd, value);
    const artifactDir = await realpath(at(args.artifact));
    const opened = await openArtifactDirectory(artifactDir);
    if (!opened.ok) throw new QualityImportError('Workspace artifact did not validate.');
    const artifact = opened.artifact;
    const validate = async (report: ArchitectureReview): Promise<ArchitectureReview> => {
      if (report.analysisId !== artifact.manifest.analysisId || report.repoId !== artifact.manifest.repo.repoId)
        throw new QualityImportError('Workspace review belongs to a different artifact.');
      const frames = artifact.manifest.frames;
      const currentAt = frames.findIndex(frame => frame.snapshotId === report.current.snapshotId && frame.commit.oid === report.current.commitOid);
      const baselineAt = report.baseline ? frames.findIndex(frame => frame.snapshotId === report.baseline!.snapshotId && frame.commit.oid === report.baseline!.commitOid) : -1;
      if (currentAt < 0 || (report.baseline && (baselineAt < 0 || baselineAt >= currentAt)))
        throw new QualityImportError('Workspace review snapshots do not match this artifact in order.');
      const current = await artifact.frame(currentAt, ctx.io.signal);
      const baseline = baselineAt < 0 ? null : await artifact.frame(baselineAt, ctx.io.signal);
      if (!current.ok || (baseline && !baseline.ok)) throw new QualityImportError('Workspace artifact frames did not validate.');
      return validateArchitectureReview(canonicalJson(report), artifact.manifest.analysisId, current.graph, baseline?.ok ? baseline.graph : null);
    };
    let workspace: ReviewWorkspace;
    if (args.action === 'init' || args.action === 'import') {
      const input = (await readWorkspaceFile(at(args.input))).text;
      if (args.action === 'import') {
        workspace = parseReviewWorkspace(input);
        await validate(workspace.report);
      } else {
        const value = parseBoundedReviewJson(input, ARCHITECTURE_LIMITS.reportBytes);
        const report = ArchitectureReviewSchema.safeParse(value);
        if (!report.success) throw new QualityImportError('Choose a valid architecture review for initialization.');
        workspace = createReviewWorkspace(await validate(report.data));
      }
      if (ctx.io.signal.aborted) return EXIT.cancelled;
      await initializeWorkspace(at(args.out!), artifactDir, workspace);
    } else {
      const directory = at(args.input);
      await assertWorkspaceOutside(artifactDir, directory);
      if (args.action === 'decide') {
        const state = WorkspaceDecisionStateSchema.safeParse(args.state);
        const owner = WorkspaceOwnerSchema.safeParse(args.owner ?? 'unassigned');
        const revision = args.expectedRevision ?? '';
        if (!state.success || !owner.success || !args.issue || !/^\d+$/.test(revision)
          || !Number.isSafeInteger(Number(revision)) || Number(revision) > WORKSPACE_LIMITS.revisions)
          throw new UsageError('Decision requires --issue, a documented --state/--owner and --expected-revision.');
        workspace = await updateWorkspace(directory, Number(revision), async current => {
          await validate(current.report);
          return decideReviewWorkspace(current, Number(revision), args.issue!, state.data, owner.data);
        }, ctx.io.signal);
      } else {
        workspace = await loadWorkspace(directory);
        await validate(workspace.report);
        if (ctx.io.signal.aborted) return EXIT.cancelled;
        if (args.action === 'export') await exportWorkspace(directory, artifactDir, at(args.out!), workspace);
      }
    }
    const counts = {
      retainedIssues: workspace.report.rows.length,
      evidenceRowsOmitted: workspace.report.rowsOmitted,
      decisions: workspace.decisions.length,
      withoutDecision: workspace.report.rows.length - workspace.decisions.length,
    };
    const decisions = new Map(workspace.decisions.map(decision => [decision.issueId, decision]));
    const issues = workspace.report.rows.map(row => ({
      issueId: row.id, ruleId: row.ruleId, kind: row.kind,
      state: decisions.get(row.id)?.state ?? 'needs-review',
      owner: decisions.get(row.id)?.owner ?? 'unassigned',
      changedRevision: decisions.get(row.id)?.changedRevision ?? null,
    }));
    if (ctx.json) ctx.print(JSON.stringify({
      ok: true, format: workspace.format, id: workspace.id, reportSha256: workspace.reportSha256,
      revision: workspace.revision, counts, decisions: workspace.decisions, issues,
      analysisId: workspace.report.analysisId, currentCommit: workspace.report.current.commitOid,
      baselineCommit: workspace.report.baseline?.commitOid ?? null, coverageReasons: workspace.report.reasons,
      evidenceValidation: 'recomputed-from-supplied-artifact', artifactProvenance: 'not-authenticated',
      policyOverride: 'none', ownership: 'local-queue-declarations',
    }));
    else {
      ctx.print(`Local review workspace: revision ${workspace.revision}; ${counts.decisions} decisions for ${counts.retainedIssues} retained issues (${counts.evidenceRowsOmitted} evidence rows omitted).`);
      ctx.print(`Current commit ${workspace.report.current.commitOid}; baseline ${workspace.report.baseline?.commitOid ?? 'not selected'}.`);
      for (const reason of workspace.report.reasons) ctx.print(`Coverage: ${architectureReasonLabel(reason)}.`);
      if (args.action === 'inspect') {
        for (const issue of issues.slice(0, 20)) ctx.print(`${issue.issueId}  ${issue.ruleId}: ${issue.state} (${issue.owner}).`);
        if (issues.length > 20) ctx.print(`${issues.length - 20} more retained issues are available with --json.`);
      }
      ctx.print('The report was recomputed from the supplied artifact. Producer and ownership declarations are not authenticated. Decisions never change architecture CI results.');
      if (args.action === 'export') ctx.print('Portable copy written. Deleting this workspace does not revoke exported copies.');
    }
    return EXIT.ok;
  } catch (error) {
    if (error instanceof UsageError) throw error;
    if (ctx.io.signal.aborted) return EXIT.cancelled;
    const message = error instanceof QualityImportError ? error.message
      : 'Local workspace operation failed. Check permissions, matching artifact and current revision before retrying. An interruption after atomic commit can leave a completed update.';
    if (ctx.json) ctx.print(JSON.stringify({ ok: false, code: 'LOCAL_WORKSPACE_FAILED', message }));
    else ctx.note(message);
    return EXIT.failure;
  }
}
