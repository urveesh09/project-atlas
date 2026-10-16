# Contributing to ATLAS

Thank you for helping. ATLAS has a few rules that keep its results trustworthy; please read
[AGENTS.md](AGENTS.md) (it applies to people as much as to coding agents) and
[Start here](docs/START_HERE.md) before a larger change.

## Ground rules

- **Repositories are data, never code.** Nothing may check out, install, build or run
  anything from an analyzed repository.
- **Honest evidence.** Never weaken a test, budget or assertion to make a check pass.
  A fix records the original failure, its cause and the retest.
- **Exact bytes.** A change that should preserve output must pass
  `node scripts/check-repository-baseline.mjs`.
- **Decisions are recorded.** A non-obvious design choice gets an ADR in `docs/adr/`. An
  accepted ADR is superseded by a new one, never silently rewritten.

## Workflow

1. Open an issue first for anything beyond a small fix, so the approach can be agreed.
2. Work on a branch and open a pull request against `main`. Keep pull requests focused.
3. Use the pinned toolchain (Node 24.22.0, pnpm 10.34.6; see [docs/toolchain.md](docs/toolchain.md)):

   ```sh
   pnpm install --frozen-lockfile
   pnpm verify    # typecheck, viewer build, dependency direction, contracts, tests
   ```

4. Explain *why* in commit messages, not only what. Do not skip hooks.
5. All CI checks must pass. A maintainer reviews every pull request before merge.

## Reporting problems

- Bugs and feature ideas: use the issue forms.
- Pilot users: the **Pilot feedback** form helps us most.
- Security issues: never in public; see [SECURITY.md](SECURITY.md).

By contributing you agree that your contribution is licensed under the MIT
[license](LICENSE) and that you will follow the [code of conduct](CODE_OF_CONDUCT.md).
