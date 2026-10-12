# Security policy

ATLAS analyzes repositories as data. It never runs code from an analyzed repository, and
artifacts contain no source text, author emails, commit messages or absolute paths
([AGENTS.md](AGENTS.md)). A report that any of these guarantees can be broken is a
security issue.

## Reporting a vulnerability

Please report privately through GitHub:
**Security → Report a vulnerability** on this repository
([private vulnerability reporting](https://docs.github.com/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)).
Do not open a public issue, pull request or discussion for a suspected vulnerability.

Include:
- the affected version or commit;
- what an attacker controls (repository contents, artifact files, hosted request, URL);
- the steps or a minimal repository or artifact that reproduces it;
- what you observed and what you expected.

We aim to acknowledge a report within 3 working days and to agree a disclosure date
with you; 90 days is the default. Reporters are credited in the advisory unless they
prefer otherwise.

## Scope

In scope:
- the analyzer, ingest and egress broker (`packages/*`);
- the CLI and its local server;
- the viewer;
- the hosted API and worker, and their container images (`apps/*`, `deploy/`).

Especially in scope:
- execution of repository content;
- escape from an analysis sandbox;
- network egress beyond the broker allowlist;
- leakage of source text or personal data into artifacts or logs;
- artifact validation bypasses;
- management tokens in URLs.

Out of scope: denial of service through repository size within the documented limits,
findings that need a compromised operator host, and reports from automated scanners without
a demonstrated impact.

## Supported versions

Before 1.0, only the latest release and `main` receive security fixes.
