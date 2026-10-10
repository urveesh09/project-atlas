import { parseArgs } from 'node:util';
import { ANALYZER_VERSION } from '@atlas/analyzer-core';
import { analyze, analyzeErrorExit } from './commands/analyze.js';
import { doctor } from './commands/doctor.js';
import { inspect } from './commands/inspect.js';
import { verify } from './commands/verify.js';
import { EXIT, UsageError, createContext, type CliIO } from './context.js';
import { PALETTE, createStyler, detectColorLevel } from './ui/style.js';

const HELP = `
  atlas ${ANALYZER_VERSION} — explore a TS/JS repository as an explainable miniature city

  Usage
    atlas doctor                       check runtime, Git and isolation
    atlas analyze [dir] [options]      analyze the committed tree into an artifact
    atlas inspect <artifact> [--no-map]  report on an artifact, with a city plan
    atlas verify <artifact>            validate an artifact end to end

  Analyze options
    --out <dir>              output directory (default ./atlas-output)
    --ref <ref|sha>          branch, tag or full commit ID (default HEAD)
    --exclude <glob>         extra exclusion pattern (repeatable)
    --replace                replace an existing ATLAS artifact at --out
    --repo-id <uuid>         reuse a repository identity
    --previous <artifact>    reuse identity and options from a previous artifact
    --max-files <n>          lower the included-file limit (at most 10,000)
    --no-history             skip Git history (history arrives in a later release)
    --history-days <1..90>   --history-commits <1..200>   --snapshots <1..12>

  Global
    --json                   machine-readable output on stdout
    -h, --help   -v, --version

  Exit codes: 0 complete · 2 partial · 1 failure · 64 usage · 130 cancelled
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
  process.exitCode = interrupted ? EXIT.cancelled : code;
}
