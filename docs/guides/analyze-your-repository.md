# Analyze your own repository

This guide takes about ten minutes. You need no account, and your code never leaves your
machine. ATLAS reads the committed files of a Git repository, writes a source-free analysis
folder, and opens it in your browser as the same city you saw in the
[live demo](https://urveesh09.github.io/project-atlas/).

**What ATLAS analyzes:** TypeScript and JavaScript (`.ts`, `.tsx`, `.js`, `.jsx`, `.mts`,
`.cts`, `.mjs`, `.cjs`) and Python (`.py`, `.pyi`), including mixed repositories and
monorepo workspaces. Python imports, declarations, code lines and callable complexity
feed the same dependencies, findings, history and city views. Python analysis uses
the bundled WASM parser; a Python interpreter is not a CLI prerequisite.

Cython, notebooks and other unsupported languages appear as opaque buildings with
their byte size, without dependency or complexity claims. Exclusions and resource
limits can also remove files; the coverage report names them. Python resolution
reads committed project metadata, never an installed environment or executed
`setup.py`. Runtime changes to `sys.path` and nonliteral dynamic imports cannot be
fully resolved and retain their confidence/reason labels. ATLAS never installs,
builds or runs anything from your repository. See the
[capabilities](../contracts/capabilities.md) for exact support and limits.

## 1. Install the prerequisites

- **Node.js 24.22.1** or a newer 24.x release: <https://nodejs.org/en/download>.
- **Git 2.38 or newer**: <https://git-scm.com/downloads>.

Check them:

```sh
node --version   # v24.22.1 or newer 24.x
git --version    # 2.38 or newer
```

## 2. Download ATLAS

Open the [latest release](https://github.com/urveesh09/project-atlas/releases) and download:
- `atlas-cli-<version>.tar.gz`;
- `SHA256SUMS`.

Check the download and extract it into a new folder:

```sh
sha256sum -c SHA256SUMS          # macOS: shasum -a 256 -c SHA256SUMS
mkdir atlas && tar -xzf atlas-cli-*.tar.gz -C atlas
cd atlas/atlas-cli
node bin/atlas.js doctor         # checks Node, Git and that analysis stays offline
```

On Windows, PowerShell has `tar`. Run `Get-FileHash atlas-cli-*.tar.gz -Algorithm SHA256`
and compare the hash with `SHA256SUMS`.

Each release also carries a build-provenance attestation. To check that GitHub Actions
built the archive from this repository, run
`gh attestation verify atlas-cli-<version>.tar.gz --repo urveesh09/project-atlas`.

## 3. Analyze and open

```sh
node bin/atlas.js analyze /path/to/your/repository --out /path/to/atlas-output
node bin/atlas.js serve /path/to/atlas-output --repo /path/to/your/repository
```

`serve` prints a **session link**. Open it once to sign this browser in to your local
viewer; the link only works on your machine. With `--repo`, the inspector can also show
the source of a file, read from your own committed files.

Large histories can take a few minutes. `--no-history` analyzes only the latest commit,
and `--snapshots 6` samples fewer points in history. The [CLI reference](../contracts/cli.md) lists every option and exit code.

## 4. Questions the city answers

- **Where does a change belong?** Search for a file or declaration (`/`). Read its
  package, its folder trail and its neighbours.
- **What depends on this file?** Select it and choose *Imports and consumers*. Arrows
  point to imported files; the inspector lists every import statement with its line.
- **Where is the risk?** Use the *Hotspot* lens. It combines complexity, fan-in and
  recent change, and every factor is listed beside the score. It points at candidates
  for review, not at defects.
- **What changed?** Use *Compare snapshots* in the history strip under the city.

Every number in the inspector shows its unit and its policy. Type-only imports, for
example, are listed separately and excluded from default fan-in, fan-out and static
cycle metrics.

## 5. Share what you see

- **Export PNG** saves the current view. Its provenance (repository, commit, lens and
  analyzer version) is stored inside the PNG file. **Export metadata** saves the same
  provenance as JSON.
- The analysis folder contains no source text, author emails, commit messages or absolute
  paths. Whoever has the folder can open it in the viewer (*Open artifact…*).

## Troubleshooting

| You see | Do this |
|---|---|
| `doctor` reports Git older than 2.38 | Update Git |
| Exit code 2 (partial) | The analysis is usable; *Coverage* in the inspector lists what was skipped and why |
| The city is slow | Tick *Low detail*, or use the *2D map* or *File table* views |
| Your language is missing | TypeScript, JavaScript and Python (`.py`, `.pyi`) are analyzed. Cython, notebooks and other languages remain opaque buildings. Please [tell us](https://github.com/urveesh09/project-atlas/issues/new/choose) which language you need |

## Feedback

You are using a beta. The [pilot feedback form](https://github.com/urveesh09/project-atlas/issues/new/choose)
asks what you tried, what worked and what got in the way. Report security issues
privately as described in [SECURITY.md](../../SECURITY.md).
