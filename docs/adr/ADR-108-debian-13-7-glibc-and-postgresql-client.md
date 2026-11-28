# ADR-108: Debian 13.7 glibc and PostgreSQL client in the container images

Date: 2026-11-28. Status: accepted for the image security fix and the backup image build.
Updates ADR-093's and ADR-105's package pins and preserves ADR-075's scan policy.

## Evidence and cause

[PR #73's first CI run](https://github.com/urveesh09/project-atlas/actions/runs/46113389463)
failed three checks. PR #73 changes the viewer, its tests and the rehearsal's nft step, not
the images. Both causes are changes in Debian after `main` last passed these checks on
2026-11-21.

- **Image gate** ([run](https://github.com/urveesh09/project-atlas/actions/runs/46113389471)).
  - It blocked the API and sandbox images.
  - The retained reports (grype 0.120.1, database built 2026-11-27) list exactly four
    blocking findings: CVE-2026-5435 and CVE-2026-19499 (High) in `libc6` and `libc-bin`
    2.41-12+deb13u4, inherited from the Node base image.
  - Both are fixed in 2.41-12+deb13u5. Its Debian changelog names both CVEs.
  - That package reached `trixie/main` with the Debian 13.7 point release.
- **Hosted service gates** (a required check).
  - The backup tool image no longer builds: `E: Version '17.11-0+deb13u1' for
    'postgresql-client-17' was not found`.
  - Debian 13.7 replaced it with 17.12-0+deb13u1, in `trixie/main` and `trixie-security`.
- `main`'s own push run on 2026-11-21 had also failed hosted gates, at an earlier point: the
  production rehearsal's nft step failed after 81 ms with `Error`, before Docker ran. That
  step first downloads GitHub's published ranges. PR #73's run never reached it.

Versions were read with `apt-cache policy` inside the pinned base image
(`node@sha256:af02d57b…f124a0`, Debian 13.7) on 2026-11-28.

## Decision

- Add `libc6=2.41-12+deb13u5 libc-bin=2.41-12+deb13u5` to the `--only-upgrade` line of
  the shared `patched` stage in the API, sandbox and backup tool images, beside ADR-093's
  zlib pin, so builder and runtime both carry them.
- Pin the same glibc in the validation tool image, as ADR-093 did for zlib.
- Pin `postgresql-client-17=17.12-0+deb13u1` in the backup tool image. `openssl`
  3.5.7-1~deb13u3 is still published and stays pinned.
- Keep the Node base digest (ADR-105), every other package pin, the scan threshold, the
  image policy (no suppressions are added), the host toolchain, application dependencies
  and the analyzer and artifact formats unchanged.

## Verification

- Before editing, the exact install lines ran in throwaway containers of the base image:
  - every pin installed together;
  - `pg_dump` reported 17.12 (Debian 17.12-0+deb13u1);
  - `libpq5` resolved to 17.12-0+deb13u1 and `libssl3t64` to 3.5.7-1~deb13u3.
- The API, sandbox, backup tool and validation images were then built locally from
  these Dockerfiles (linux/amd64), and each was inspected with container networking
  disabled. Every image reports:
  - `libc6` and `libc-bin` 2.41-12+deb13u5;
  - zlib 1:1.3.dfsg+really1.3.1-1+deb13u1;
  - Node v24.22.3.

  The backup image's `pg_dump` reports 17.12 (Debian 17.12-0+deb13u1). The local tags
  were removed afterwards, and no other container or image was touched.
- The unchanged CI image SBOM, provenance, vulnerability and isolated registry checks,
  and the hosted gates on the exact PR head, are the acceptance evidence. The failed
  reports remain attached to the original run.
- No release, image publication or live deployment follows from this change.
