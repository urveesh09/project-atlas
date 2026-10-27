# ADR-077: Public-service pages with the owner's wording

Date: 2026-10-18. Status: accepted for M4.6, merged in [PR #45](https://github.com/urveesh09/project-atlas/pull/45) on 2026-10-18.
Builds on [ADR-072](ADR-072-reference-hosted-deployment.md) (production profile). Adds
`GET /api/v1/legal` to the public contract; analyzer and artifact versions are unchanged.

## Evidence and cause

- **A public service needs these pages.** The hosted landing had no privacy, terms or
  takedown pages and no contact, and production plan M4.6 requires them.
- **The wording must come from the owner.** The owner supplies the legal text and the
  contact; an agent must never invent legal wording.
- **The service must not start without them.** The plan requires the production
  service to refuse to start until they are configured.
- **The facts must match the code.** The plan asks the pages to describe the data
  handling the code actually does. Reading the code found:
  - **IP addresses** are never stored or logged. Quotas use an HMAC of the address and
    the day, keyed by the quota secret. It is kept with the session for 24 hours, and the
    hourly sweep removes it from job records after 24 hours. The reference proxy discards
    its logs (ADR-072).
  - **Logs** carry job IDs, stages and error codes. A repository appears only as
    `repositoryTag`, the first 16 hex digits of a SHA-256 of its numeric GitHub ID. That is
    pseudonymous: anyone who knows the ID can recompute it. It is never the name.
  - **Publications** last `publicationTtlDays` (7). They are withdrawn when the repository
    stops being public: each view needs a visibility answer at most 5 minutes old, and
    every publication is rechecked daily. Owners can delete sooner. Downloaded copies
    cannot be recalled.
  - **Job records are kept with no time limit.** Each keeps the submitted repository URL,
    and the `repositories` table keeps the canonical name and numeric ID. Nothing deletes
    them automatically.
  - **Cookies and requests:** one session cookie lasts 24 hours. The viewer's CSP allows
    only same-origin requests, and there are no analytics.
  - **Backups:** the reference kit keeps database backups for 7 days (ADR-074).

## Decision

1. **The owner's texts.**
   - `ATLAS_PRIVACY_FILE`, `ATLAS_TERMS_FILE` and `ATLAS_TAKEDOWN_FILE` name UTF-8 plain
     text files. Each must be absolute, non-empty, at most 64 KiB and free of control
     characters other than tab and newline.
   - `ATLAS_CONTACT` is `mailto:name@domain` or a plain `https:` URL, with no credentials
     or query.
   - Outside development, the API refuses to start, before any database connection,
     if any item is missing or invalid, or if a text contains `ATLAS-PLACEHOLDER`.
   - Errors name the variable, never the contents.
2. **Placeholders that cannot reach production.**
   - `deploy/production/legal.example/` ships three files carrying the marker, so the
     shape is clear and a copied example cannot go live.
   - A development service without texts shows "Placeholder", says why, and invents
     nothing.
3. **The contract.** `GET /api/v1/legal` returns `LegalNotices`:
   `{ configured, contact, documents: { privacy, terms, takedown } }`. It is in the OpenAPI
   document.
4. **The pages.**
   - `/privacy`, `/terms` and `/takedown` are viewer routes, served with the viewer's CSP.
   - The owner's text is rendered as text, never as markup; a blank line starts a
     paragraph.
   - The privacy page adds "How this service handles data", and the takedown page adds
     "What a takedown can do". Both are labelled as implementation facts, not legal
     wording, and both take day counts from the service's own limits.
   - Only `mailto:` and `https:` contacts become links, checked again in the browser.
   - The hosted landing and every page link the three pages and the contact.
5. **The production profile.**
   - The texts are mounted as Compose configs, never volumes. They are not secrets, but
     like secrets they enter the container one named file at a time.
   - `ATLAS_LEGAL_DIR` and `ATLAS_CONTACT` are required to resolve the profile.
   - The preflight checks that each variable names a mounted config and that the
     contact's scheme is allowed.
6. **The facts state the retention gap.** The privacy facts say job records are not
   deleted automatically. Choosing a retention period, and building it, is the owner's
   decision. This ADR does not set one.

## Not decided here

- **Any legal wording,** including what the owner promises, what law applies, and whether
  or how anyone is notified of an incident.
- **A retention period for job records,** and the work to enforce it.
- **A status page.** The service-levels document asks the owner to name a channel.

## Verification

- **Unit tests:**
  - the loader: valid texts are normalized (BOM, CRLF); each missing item and each
    invalid case is refused (placeholder marker, empty, oversized, non-UTF-8, control
    characters, relative or unreadable path, seven bad contacts); development
    placeholders work;
  - the API serves `/api/v1/legal` and the three page shells;
  - the viewer: routes, facts taken from the limits, paragraph splitting and contact
    safety;
  - the profile preflight's six refusal cases.
- **A hosted browser journey** (PostgreSQL, Chromium):
  - footer links lead to the placeholder privacy page with its facts, then the takedown
    page, and back;
  - a configured API shows the owner's text, no placeholder, and the contact as a
    `mailto:` link on the page and in the landing footer;
  - axe finds no violations on either page.
- **The production rehearsal** has a new step against the real API image, so it now has
  17:
  - with the shipped examples, the API exits with code 1 and logs the placeholder
    refusal;
  - with the rehearsal's texts, `/api/v1/legal` returns them and the contact, and all
    three pages are served under the viewer CSP.
- **Retained failure.** The first rehearsal failed to resolve the profile. The unquoted
  `${ATLAS_CONTACT:?…}` message contained `mailto: address`, which YAML parses as a
  mapping. The message is now quoted. Compose still refuses a missing contact, now with
  that message.
- Local and CI counts are recorded in the implementation status and the pull request.
