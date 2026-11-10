# ADR-093: Refresh Debian packages in the Node images

Date: 2026-11-09. Status: accepted for the image security fix. Updates ADR-088's
container base and preserves ADR-075's scan policy.

## Evidence and cause

[PR #57's original image run](https://github.com/urveesh09/project-atlas/actions/runs/42590323399)
blocked both API and sandbox images. The retained Grype reports show fixable
High findings for `apt` and `libapt-pkg7.0` 3.0.3 (CVE-2026-109518) and
`zlib1g` 1:1.3.dfsg+really1.3.1-1+b1 (CVE-2026-76844 and CVE-2026-85091).
The city commit changes viewer code. These packages came from the inherited
Debian base.

[DSA-6607-1](https://security-tracker.debian.org/tracker/DSA-6607-1) fixes APT
in 3.0.4. [DSA-6613-1](https://security-tracker.debian.org/tracker/DSA-6613-1)
fixes zlib in 1:1.3.dfsg+really1.3.1-1+deb13u1. Docker's official
`node:24.22.2-trixie-slim` already contains the fixed APT packages. Its Linux
amd64 filesystem still contains the older zlib package, as confirmed by
`dpkg-query` with container networking disabled.

## Decision

- Use the official multi-platform Node index
  `sha256:0820eaa85e07d0490446dd01d14707e17e6108a36988cf374899cd057eb3812d`.
  Linux amd64 resolves to manifest
  `sha256:947528b072c170d980592b851c802155d84dcad60d3f550b8a0451b84d65dabd`.
  This obtains fixed APT before any package install in our Dockerfiles.
- Install the exact fixed Debian zlib package through the image's signed
  Debian repositories. Share the patched stage between each image's builder
  and runtime, including the backup tools. Apply the same zlib pin in the
  validation tools and advance the isolated scanner cache initializer's Node
  base digest.
- Keep the host toolchain minimum, application dependencies, scan threshold,
  image roles and analyzer/artifact formats unchanged.

## Verification

Both final linux/amd64 runtime images built locally. With container networking
disabled, each reported Node 24.22.2, APT and libapt 3.0.4, and the exact
patched zlib package. The local Windows Node 24.22.2 archive matched the
[published checksum](https://nodejs.org/en/blog/release/v24.22.2).

The unchanged CI image SBOM, provenance, vulnerability and isolated registry
checks are required on the exact PR head. Both failed reports remain attached
to the original run. No release, image publication or live deployment follows
from this PR.
