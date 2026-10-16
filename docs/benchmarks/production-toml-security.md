# M1.2: full-size TOML security regression

Recorded 2026-10-16 on Windows 11 10.0.26200, Intel i5-10400, 16 GiB,
Node 24.22.0. This is a security regression diagnostic, not a capacity benchmark
or reference-hardware acceptance result. The working tree held the authored test.

## Method and expected result

`packages/analyzer-py/test/manifest-security.test.ts` runs compiled production
`discoverPythonProjects` in a disposable process with a 10-second outer deadline.
Construction/startup are outside the measured discovery interval. The input is
exactly 1,048,576 ASCII bytes: a named project, 131,061 unique dot-free keys, a
trailing optional dependency and space padding. Both the project name and the final
dependency must survive, with no warnings. The discovery interval must be below
1,000 ms. The assertion was authored before running the old-version regression.

| Version | Discovery | Result |
|---|---:|---|
| 1.8.0, authored regression | 2,504.5356 ms | Fails the unchanged 1,000 ms assertion; the other three checks pass |
| 1.9.1, same-size/input production-path diagnostic | 148.4486 ms | Name and final dependency retained, no warnings; all four regression checks pass |

An earlier characterization without the trailing dependency measured 2,575.4482 ms
on 1.8.0; it is not the exact regression fixture. These are individual observations,
not a measured percentile or a claim about all valid TOML documents.

The child deadline prevents a reintroduced synchronous stall from hanging the test
runner. The test also rejects each manifest kind at 1 MiB + 1 ASCII byte and verifies
that own-property access handles prototype-like metadata. No source from an analyzed
repository runs and no network is used by discovery.

## Boundary and upstream review

Discovery runs synchronously in the analyzer parent through `buildHierarchy`, rather
than in the bounded Python source-parser child. `inventory.ts` admits config content
only through the `sourceBlobBytes` limit (1 MiB of Git blob bytes); project discovery
also rejects text longer than 1 MiB of UTF-16 code units. The ASCII fixture reaches
both bounds exactly. No admission limit or timeout changed.

[The upstream advisory](https://github.com/squirrelchat/smol-toml/security/advisories/GHSA-r4xh-jqrq-34v2)
describes repeated whole-document scans for flat keys, fixed in 1.9.0.
[Release notes](https://github.com/squirrelchat/smol-toml/releases) also identify null
prototypes in returned tables and stricter rejection of malformed TOML; 1.9.1 fixes
invalid exponent-sign acceptance. ATLAS already reads only validated own properties.
Malformed documents continue to produce `PYPROJECT_INVALID` or `PIPFILE_INVALID`.
Corpus equality must be checked separately before accepting unchanged valid outputs.

Reproduce with the pinned dependency:

```sh
pnpm exec vitest run packages/analyzer-py/test/manifest-security.test.ts
```

The initial failure transcript is retained locally at
`.atlas-tmp/m1-dependency-evidence/toml-1.8.0-failure.log`.
