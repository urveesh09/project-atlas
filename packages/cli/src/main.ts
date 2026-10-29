import { parseArgs } from 'node:util';
import { ANALYZER_VERSION } from '@atlas/analyzer-core';
import { analyze, analyzeErrorExit } from './commands/analyze.js';
import { doctor } from './commands/doctor.js';
import { inspect } from './commands/inspect.js';
import { serve } from './commands/serve.js';
import { verify } from './commands/verify.js';
import { findings } from './commands/findings.js';
import { scanEvidence, verifyScan } from './commands/scan.js';
import { reviewFindings } from './commands/review-findings.js';
import { reviewArchitectureCommand } from './commands/review-architecture.js';
import { EXIT, UsageError, createContext, type CliIO } from './context.js';
import { PALETTE, createStyler, detectColorLevel } from './ui/style.js';

const HELP = `
  atlas ${ANALYZER_VERSION} — explore a TypeScript, JavaScript or Python repository as an explainable miniature city

  Usage
    atlas doctor                       check runtime, Git and isolation
    atlas analyze [dir] [options]      analyze the committed tree into an artifact
    atlas inspect <artifact> [--no-map]  report on an artifact, with a city plan
    atlas verify <artifact>            validate an artifact end to end
    atlas findings <ruff.sarif> --artifact <dir> --commit <full-oid> --out <quality.json>
                                       import local external findings (no scanner execution)
      [--source-root <dir>] [--baseline <quality.json>]
    atlas scan-evidence <quality.json> --artifact <dir> --profile <profile.json>
      --scope <scope.json> --exit-code <0|1> --out <scan.json>
    atlas verify-scan <scan.json> --artifact <dir> --bundle <sigstore.json>
      --policy <trust.json> --trusted-root <root.json> [--gh <absolute-executable>]
    atlas review-findings <current.scan.json> --baseline <old.scan.json>
      --artifact <dir> --repo <dir> --out <review.json>
      [--current-proof <dir> --baseline-proof <dir> [--gh <absolute-executable>]]
    atlas review-architecture <artifact> --policy <policy.json> --commit <full-oid>
      --out <review.json> [--baseline <earlier-full-oid>] [--markdown] [--fail-on new|all]
    atlas serve <artifact> [--repo <dir>] [--no-open] [--port <n>]
                                       browse an artifact in your browser (127.0.0.1 only)

  Analyze options
    --out <dir>              output directory (default ./atlas-output)
    --ref <ref|sha>          branch, tag or full commit ID (default HEAD)
    --exclude <glob>         extra exclusion pattern (repeatable)
    --replace                replace an existing ATLAS artifact at --out
    --repo-id <uuid>         reuse a repository identity
    --previous <artifact>    reuse identity and options from a previous artifact
    --max-files <n>          lower the included-file limit (at most 10,000)
    --no-history             skip Git history (structure, dependencies and findings still run)
    --history-days <1..90>   --history-commits <1..200>   --snapshots <1..12>

  Global
    --json                   machine-readable output on stdout
    -h, --help   -v, --version

  Exit codes: 0 complete · 2 partial · 3 explicit architecture policy blocked · 1 failure · 64 usage · 130 cancelled
`;

function intOption(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new UsageError(`${name} must be a whole number`);
  return Number(value);
}

export async function run(argv: readonly string[], io: CliIO): Promise<number> {
  const [command, ...rest] = argv;
  const json = rest.includes('--json');
  if (!command || command === '-h' || command === '--help' || command === 'help') {
    io.stdout.write(HELP);
    return command ? EXIT.ok : EXIT.usage;
  }
  if (command === '-v' || command === '--version') {
    io.stdout.write(`${ANALYZER_VERSION}\n`);
    return EXIT.ok;
  }
  const ctx = createContext(io, json);
  try {
    switch (command) {
      case 'review-architecture': {
        const { values, positionals } = parseArgs({
          args: rest, allowPositionals: true, strict: true,
          options: {
            policy: { type: 'string' }, commit: { type: 'string' },
            baseline: { type: 'string' }, out: { type: 'string' },
            markdown: { type: 'boolean' }, 'fail-on': { type: 'string' }, json: { type: 'boolean' },
          },
        });
        const failOn = values['fail-on'];
        if (positionals.length !== 1 || !values.policy || !values.commit || !values.out || values.baseline === ''
          || (failOn !== undefined && failOn !== 'new' && failOn !== 'all')
          || (failOn === 'new' && !values.baseline)) {
          throw new UsageError('review-architecture requires one artifact, --policy, --commit and --out. --fail-on accepts new|all; new requires --baseline.');
        }
        return await reviewArchitectureCommand(ctx, {
          artifact: positionals[0]!, policy: values.policy, commit: values.commit, out: values.out,
          markdown: values.markdown ?? false,
          ...(values.baseline ? { baseline: values.baseline } : {}),
          ...(failOn ? { failOn } : {}),
        });
      }
      case 'doctor': {
        parseArgs({ args: rest, options: { json: { type: 'boolean' } }, strict: true, allowPositionals: false });
        return await doctor(ctx);
      }
      case 'analyze': {
        const { values, positionals } = parseArgs({
          args: rest,
          allowPositionals: true,
          strict: true,
          options: {
            out: { type: 'string' },
            ref: { type: 'string' },
            exclude: { type: 'string', multiple: true },
            replace: { type: 'boolean' },
            'repo-id': { type: 'string' },
            previous: { type: 'string' },
            'no-history': { type: 'boolean' },
            'history-days': { type: 'string' },
            'history-commits': { type: 'string' },
            snapshots: { type: 'string' },
            'max-files': { type: 'string' },
            json: { type: 'boolean' },
          },
        });
        if (positionals.length > 1) throw new UsageError('analyze takes one repository directory');
        if (values['repo-id'] && values.previous) throw new UsageError('Use either --repo-id or --previous, not both');
        if (values['no-history'] && (values['history-days'] || values['history-commits'] || values.snapshots)) {
          throw new UsageError('--no-history conflicts with --history-days, --history-commits and --snapshots');
        }
        const history: { enabled: boolean; days?: number; commits?: number; snapshots?: number } = { enabled: !values['no-history'] };
        const days = intOption(values['history-days'], '--history-days');
        const commits = intOption(values['history-commits'], '--history-commits');
        const snapshots = intOption(values.snapshots, '--snapshots');
        if (days !== undefined) history.days = days;
        if (commits !== undefined) history.commits = commits;
        if (snapshots !== undefined) history.snapshots = snapshots;
        const maxFiles = intOption(values['max-files'], '--max-files');
        return await analyze(ctx, {
          ...(maxFiles !== undefined ? { maxFiles } : {}),
          repo: positionals[0] ?? '.',
          out: values.out ?? 'atlas-output',
          replace: values.replace ?? false,
          exclude: values.exclude ?? [],
          history,
          ...(values.ref !== undefined ? { ref: values.ref } : {}),
          ...(values['repo-id'] !== undefined ? { repoId: values['repo-id'] } : {}),
          ...(values.previous !== undefined ? { previous: values.previous } : {}),
        });
      }
      case 'inspect': {
        const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, strict: true, options: { json: { type: 'boolean' }, 'no-map': { type: 'boolean' } } });
        if (positionals.length !== 1) throw new UsageError('inspect takes one artifact directory');
        return await inspect(ctx, { artifact: positionals[0]!, map: !values['no-map'] });
      }
      case 'verify': {
        const { positionals } = parseArgs({ args: rest, allowPositionals: true, strict: true, options: { json: { type: 'boolean' } } });
        if (positionals.length !== 1) throw new UsageError('verify takes one artifact directory');
        return await verify(ctx, { artifact: positionals[0]! });
      }
      case 'serve': {
        const { values, positionals } = parseArgs({
          args: rest,
          allowPositionals: true,
          strict: true,
          options: { repo: { type: 'string' }, 'no-open': { type: 'boolean' }, port: { type: 'string' }, json: { type: 'boolean' } },
        });
        if (positionals.length !== 1) throw new UsageError('serve takes one artifact directory');
        const port = intOption(values.port, '--port');
        if (port !== undefined && port > 65_535) throw new UsageError('--port must be at most 65535');
        return await serve(ctx, { artifact: positionals[0]!, open: !values['no-open'], ...(values.repo !== undefined ? { repo: values.repo } : {}), ...(port !== undefined ? { port } : {}) });
      }
      case 'findings': {
        const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, strict: true,
          options: { artifact: { type: 'string' }, commit: { type: 'string' }, out: { type: 'string' }, 'source-root': { type: 'string' }, baseline: { type: 'string' }, json: { type: 'boolean' } } });
        if (positionals.length !== 1 || !values.artifact || !values.commit || !values.out)
          throw new UsageError('findings requires one Ruff SARIF report, --artifact, --commit and --out.');
        return await findings(ctx, { report: positionals[0]!, artifact: values.artifact, commit: values.commit, out: values.out,
          ...(values['source-root'] !== undefined ? { sourceRoot: values['source-root'] } : {}), ...(values.baseline !== undefined ? { baseline: values.baseline } : {}) });
      }
      case 'scan-evidence': {
        const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, strict: true, options: { artifact: { type: 'string' }, profile: { type: 'string' }, scope: { type: 'string' }, 'exit-code': { type: 'string' }, out: { type: 'string' }, json: { type: 'boolean' } } });
        if (positionals.length !== 1 || !values.artifact || !values.profile || !values.scope || !values.out || !['0', '1'].includes(values['exit-code'] ?? '')) throw new UsageError('scan-evidence requires quality JSON, --artifact, --profile, --scope, --exit-code 0|1 and --out.');
        return await scanEvidence(ctx, { quality: positionals[0]!, artifact: values.artifact, profile: values.profile, scope: values.scope, exitCode: Number(values['exit-code']), out: values.out });
      }
      case 'verify-scan': {
        const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, strict: true, options: { artifact: { type: 'string' }, bundle: { type: 'string' }, policy: { type: 'string' }, 'trusted-root': { type: 'string' }, gh: { type: 'string' }, json: { type: 'boolean' } } });
        if (positionals.length !== 1 || !values.artifact || !values.bundle || !values.policy || !values['trusted-root']) throw new UsageError('verify-scan requires scan JSON, --artifact, --bundle, --policy and --trusted-root.');
        return await verifyScan(ctx, { evidence: positionals[0]!, artifact: values.artifact, bundle: values.bundle, policy: values.policy, trustedRoot: values['trusted-root'], ...(values.gh ? { gh: values.gh } : {}) });
      }
      case 'review-findings': {
        const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, strict: true, options: { baseline: { type: 'string' }, artifact: { type: 'string' }, repo: { type: 'string' }, out: { type: 'string' }, 'current-proof': { type: 'string' }, 'baseline-proof': { type: 'string' }, gh: { type: 'string' }, json: { type: 'boolean' } } });
        if (positionals.length !== 1 || !values.baseline || !values.artifact || !values.repo || !values.out || Boolean(values['current-proof']) !== Boolean(values['baseline-proof']) || values['current-proof'] === '' || values['baseline-proof'] === '' || values.gh === '' || (values.gh !== undefined && !values['current-proof'])) throw new UsageError('review-findings requires current scan, --baseline, --artifact, --repo and --out. Supply both nonempty proof directories or neither; --gh requires proofs.');
        return await reviewFindings(ctx, { current: positionals[0]!, baseline: values.baseline, artifact: values.artifact, repo: values.repo, out: values.out, ...(values['current-proof'] ? { currentProof: values['current-proof'], baselineProof: values['baseline-proof']! } : {}), ...(values.gh ? { gh: values.gh } : {}) });
      }
      default:
        throw new UsageError(`Unknown command "${command}". Run atlas --help.`);
    }
  } catch (error) {
    const mapped = analyzeErrorExit(error) ?? (isParseArgsError(error) ? { exit: EXIT.usage, message: (error as Error).message } : null);
    const s = createStyler(detectColorLevel(io.env, io.stderr.isTTY === true));
    if (mapped) {
      if (json) io.stdout.write(`${JSON.stringify({ type: 'error', exit: mapped.exit, message: mapped.message })}\n`);
      io.stderr.write(`\n  ${s.fg(mapped.exit === EXIT.cancelled ? PALETTE.warn : PALETTE.error, mapped.exit === EXIT.usage ? 'usage:' : 'error:')} ${mapped.message}\n\n`);
      return mapped.exit;
    }
    io.stderr.write(`\n  ${s.fg(PALETTE.error, 'internal error:')} ${(error as Error)?.message ?? String(error)}\n\n`);
    return EXIT.failure;
  }
}

function isParseArgsError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code ?? '';
  return typeof code === 'string' && code.startsWith('ERR_PARSE_ARGS');
}

/** Process entry point: wires real streams, SIGINT cancellation and the exit code. */
export async function cli(): Promise<void> {
  const controller = new AbortController();
  let interrupted = false;
  process.on('SIGINT', () => {
    if (interrupted) process.exit(EXIT.cancelled);
    interrupted = true;
    controller.abort();
  });
  const code = await run(process.argv.slice(2), {
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    cwd: process.cwd(),
    signal: controller.signal,
  });
  // Ctrl+C is how `serve` stops normally; other commands report cancellation themselves.
  process.exitCode = interrupted && code !== EXIT.ok ? EXIT.cancelled : code;
}
