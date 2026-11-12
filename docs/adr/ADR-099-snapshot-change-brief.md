# ADR-099: Download a change brief from Compare

Date: 2026-11-12. Status: accepted for artifact viewing.

## Evidence and cause

Compare shows file changes, import evidence and consumer paths. Sharing a
review currently requires copying observations and recording which two
commits supplied them. The artifact already carries the identities and
metrics needed to make a reproducible handoff.

## Decision

- Download Markdown for the ordered A → B pair in the current artifact.
  Identify the analysis, both full commit IDs, and the HEAD commit used
  for the hotspot cohort. Export whole-snapshot counts regardless of
  selection and filters.
- Compare recorded static cycle components by their sorted member
  lineages, following ADR-089. Group occurrence-scoped SCC IDs within a
  frame. A rename preserves membership. An unidentifiable member leaves
  its component outside the comparison and is disclosed.
- Include observed dependency counts and examples in each direction.
  Rank comparable hotspot changes by absolute point movement, then
  repository path. Keep availability changes separate and disclose
  the number of shared files with scores on both sides.
- Keep snapshot coverage with the evidence. Differences can reflect
  changed coverage or resolution. The brief carries static observations
  and supplies no policy, security, or runtime verdict.
- Show up to five dependency examples per side, four cycle components per
  side with four members each, and eight score changes. List omissions and
  shorten labels to 160 code points. Use the same text escaping as architecture
  reports to avoid introducing Markdown structure or links. The browser
  creates the file on explicit request.
  [CommonMark character references](https://spec.commonmark.org/0.31.2/#entity-and-numeric-character-references)

## Verification

Check rename continuity, changed component membership, unavailable
scores, exact A/B reversal, hostile labels, and output bounds. Download
the brief with the keyboard against authored history, check the exact
commit pair, and exercise narrow-screen reflow and the browser matrix.
