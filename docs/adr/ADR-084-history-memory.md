# ADR-084: Hold history within the 2 GiB job

Date: 2026-10-20. Status: accepted, merged in [PR #49](https://github.com/urveesh09/project-atlas/pull/49) on 2026-10-20. Production
M5.2. Memory only: analyzer `0.1.0-dev.10` output, the artifact and its limits are
unchanged, so the analyzer version is not bumped.

## Evidence and cause

**The exact large history used 96.5% of the job's memory.** The first container diagnostic
of [ADR-083](ADR-083-fit-the-export.md) (exact large history, 4 CPUs, 2 GiB, no swap)
peaked at 2,072,801,280 bytes of 2,147,483,648, with no memory events; dev.9 had peaked at
1,970,372,608 on the same fixture. A hosted job that close to its cap fails on the next
slightly larger repository.

**Profile** (in-process, `--max-old-space-size=1536` as in the sandbox, full GC at each stage
transition):
- the parent's live heap grew by about 84 MB for each analyzed frame, from 254 MB after the
  selected frame to 894 MB after the eighth;
- the result needs 522 MB;
- the two parser children (about 200 MB each) are alive only while frames are analyzed;
- so the peak was the frame phase: parent resident memory up to 1,574 MB, plus the
  children.

What the frame phase held beyond what assembly needs:
1. **Every analyzed snapshot's inventory, with each file's decoded source text, and its parse
   facts.** Only the selected snapshot's file roles, excluded roots, cache hits and cycle
   count are read afterwards (the summary).
2. **Facts and blob bytes for every blob in the window.** The fact cache held 18,330 entries
   (52 MB as JSON) and the blob cache every source buffer. Frames are analyzed newest first,
   and a frame shares its blobs with the frame before; a blob neither of the last two frames
   used returns only when a file goes back to earlier content.
3. **Every kept frame's final graph, about 70 MB each.** Each kept historical frame is
   already encoded and proven when it is kept (ADR-083), and the next frame is encoded
   against the selected frame or the newest kept one only. Older ones wait for assembly.
4. **A heap snapshot at a quarter of the scale** (2,500 files, 12 frames) found one
   avoidable duplicate: each resolution built its resolver mode (`bundler/esm`) as a new
   string, 282,960 copies (8.6 MB). Edge and evidence IDs (47 MB at that scale) are
   per-snapshot by design (plan §6.2) and are not changed.

## Decision

1. **A snapshot outcome keeps its graph and the summary's inputs only.** The inventory and
   parse facts are released when the snapshot is analyzed; a historical frame's raw outcome is
   released once its final graph exists.
2. **The analysis' own caches keep two frames** (`FrameFactCache`, `BlobCache.advance()`):
   after each analyzed frame, entries that neither it nor the frame before used are released.
   - A released fact that is needed again is parsed again, with the same facts.
   - A released blob is read from Git again. Every blob read stays counted, so the history
     source budget (plan §4.2) is decided exactly as before and never counts a blob twice.
   - A fact cache supplied by the caller is kept whole.
3. **Hold older kept frames as their encoded delta, and restore them for assembly.**
   - When a frame is kept, the kept frame before it (not the selected one) is released. Its
     canonical delta wire is kept, deflated privately with Node's zlib, whatever transport
     the caller packs with.
   - Assembly restores each held frame against its restored base, newest first: it inflates
     the wire and checks its SHA-256 against the chunk's `encodedSha256`, decodes it, and
     checks the canonical digest of the decoded graph against the chunk's `sha256`. Either
     mismatch fails the analysis (`INTERNAL_ERROR`); it is never packed.
   - The restored graph is adopted for its chunk (`FrameChunkCache.adopt`), so packing
     reuses the chunk bytes instead of encoding the frame again.
   - Restoring decodes and proves the frame again, a subset of what encoding it did. The
     measured encode time of every held frame is added to the export reserve (ADR-083
     decision 5), so frame expansion still stops in time to assemble.
   - Without a transport nothing is encoded, and nothing is held.
4. **One string per resolver mode.**
5. **The history benchmark passes no fact cache**, like the worker, so it measures the
   analysis' own cache.

**Not changed:** analysis results, frame selection, the artifact bytes, and the 1,536 MiB
parent heap and 512 MiB parser-child heap limits.

## Verification

- **Identical artifacts.** On the exact large history, the manifest's chunk list and every
  frame's chunk digests are identical to commit `bf6f282` (before this change): chunk-list
  digest `dd3b3c07…`, frame digest `00d6fb6c…`; 6 frames, 112,750,104 stored and
  12,927,021 compressed bytes.
- **Memory, in-process** (exact large history, `--max-old-space-size=1536`, Windows host,
  `bf6f282` and this change run one after the other on the same fixture):

| | `bf6f282` | This change |
|---|---:|---:|
| Live heap after all frames (separate runs with a full GC at each stage) | 894 MB | 446 MB |
| Parent resident memory, peak while parsing (children alive) | 1,542 MB | 1,313 MB |
| Parent resident memory, peak while assembling (children exited) | 1,656 MB | 1,485 MB |
| Time | 123.0 s | 136.8 s |

  Restoring six held frames took about 18 s (about 1.5 s decoding and 1.25 s proving each);
  less garbage collection recovers part of it.
- **Tests:**
  - `held-frames.test.ts`: on Harbor, every kept frame but the selected one and the oldest
    is held and restored (counted), and the graphs, history and layout equal an analysis
    without a transport, whose fresh encoding gives the same chunks;
  - the fact cache keeps two frames and never caches environment failures;
  - the blob cache releases bytes two frames old, reads them again from Git, and counts them
    once against the budget;
  - the ADR-083 export-fit tests and the Harbor cross-platform digest golden pass unchanged.
- **In the 4-CPU/2-GiB container** (one diagnostic run each, image from `d4837fd`): the
  exact large history peaks at 1,769,410,560 bytes (82.4%), down from 2,072,801,280
  (96.5%), in 150.57 s against 144.63 s, with no memory events; details in
  [ADR-082](ADR-082-exact-capacity-fixtures.md). The 20-run rows are pending.
