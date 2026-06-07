# WF-P4-ARTIFACT — Cases and Tests

- Workflow: WF-P4-ARTIFACT
- Phase: P4 Event Log & Artifact Foundation
- Step: 1 (Cases and Tests)
- Date: 2026-06-08
- Author: subagent (workflow lead)

## Slice Boundary

- Slice name: WF-P4-ARTIFACT
- Bounded context: Artifact and Context Carrier (owned by the artifact manager).
  The `artifact/` module is the single owner of artifact path allocation,
  path-safety validation, content write and `artifacts.jsonl` index append. It
  consumes Node built-ins (`node:path`, `node:fs/promises`, `node:crypto`) only;
  it MUST NOT import from `commander`, `execa`, `simple-git`, or any
  infrastructure adapter outside `src/utils`. It depends on `src/utils/errors`
  for the `ArtifactError` taxonomy entry and on a Clock-shaped `now()`
  injectable for `created_at`.
- User tasks covered: **none — technical workflow.** Artifact creation is an
  internal capability consumed by Script Step, Check Step and Agent Step in
  later phases (P5+). No CLI surface is delivered in WF-P4-ARTIFACT.
- Planned test files (1 / max 2):
  - `tests/artifact/artifact.test.ts` — unit tests for `assertPathSafe`,
    `artifactPath`, `writeArtifact`, `appendArtifactIndex`, and the
    retry-attempt isolation invariant.

Slice within 0-user-task and 2-test-file budget. Wiring into Script Step and
Agent Step (the consumers of `writeArtifact`) is reserved for P5; Step 2 of
WF-P4-ARTIFACT only delivers the artifact module itself.

## Workflow Goal

Deliver the `artifact/` module as the single source of truth for artifact
metadata production, path allocation, path-safety enforcement, content write
and the `artifacts.jsonl` index:

- `assertPathSafe(runDir, relPath)` — throws `ArtifactError` if `relPath` is
  empty, absolute, contains `..` traversal, or would resolve outside `runDir`.
  Returns `void` on success.
- `artifactPath(runDir, job, attempt, step, filename)` — returns the absolute
  on-disk path for an artifact, following the pattern
  `jobs/<job>/attempts/<attempt>/steps/<step>/<filename>` relative to
  `runDir`. The returned path MUST be inside `runDir` (verified internally
  via `assertPathSafe`).
- `writeArtifact(opts)` — creates the step directory (recursive), writes
  `content` to `<runDir>/<relPath>`, then returns the populated
  `ArtifactMetadata` object including `id`, `run_id`, `producer`, `kind`,
  `path` (relative), `content_type`, `size` (byte length of written content),
  `summary` and `created_at` (ISO 8601 from injected clock).
- `appendArtifactIndex(runDir, metadata)` — appends the metadata as one JSON
  line to `<runDir>/artifacts.jsonl`. Existing entries MUST be preserved
  (append-only). Creates the file on first call.

Retry isolation: writing the same `<job, step, kind, filename>` for attempts
1 and 2 MUST produce two distinct paths under
`jobs/<job>/attempts/1/...` and `jobs/<job>/attempts/2/...` respectively, and
the attempt-2 write MUST NOT alter the attempt-1 file.

## Acceptance Criteria

1. **M1 Path Safety Guard (FP-ART-SAFE)**
   - Safe relative path (e.g. `jobs/a/attempts/1/steps/b/stdout.log`) passes
     without throwing.
   - Empty string is rejected with `ArtifactError`.
   - Absolute POSIX path (`/etc/passwd`) is rejected with `ArtifactError`.
   - Absolute Windows path (`C:\\Windows\\System32`) is rejected with
     `ArtifactError` when running on Windows; the rejection criterion is "path
     resolves outside `runDir`", which covers both styles.
   - `..` traversal (`jobs/../../escape`) that would resolve outside `runDir`
     is rejected with `ArtifactError`.
   - Mid-path `..` that still resolves inside `runDir` (e.g.
     `jobs/a/../a/file`) is accepted — the contract enforces final-resolved
     location, not lexical absence of `..`.

2. **M2 Path Allocation (FP-ART-PATH)**
   - `artifactPath(runDir, "build", 1, "compile", "stdout.log")` returns
     `<runDir>/jobs/build/attempts/1/steps/compile/stdout.log` (or platform
     equivalent via `node:path.join`).
   - Returned absolute path, when made relative to `runDir`, equals the
     pattern `jobs/<job>/attempts/<attempt>/steps/<step>/<filename>`.
   - Returned path resolves to a location under `runDir` (path-safety
     invariant holds for every output of `artifactPath`).

3. **M3 Artifact Write + Metadata (FP-ART-WRITE)**
   - The on-disk file at the allocated path exists after `writeArtifact`
     completes and contains exactly the provided `content` bytes.
   - Returned metadata includes every required field from §2.5: `id`,
     `run_id`, `producer`, `kind`, `path`, `content_type`, `size`,
     `summary`, `created_at`.
   - `metadata.path` is the **relative** path
     `jobs/<job>/attempts/<attempt>/steps/<step>/<filename>` (POSIX-style
     separators) — NOT the absolute on-disk path.
   - `metadata.id` follows the
     `artifact://<run_id>/jobs/<job>/attempts/<attempt>/steps/<step>/<filename-stem>`
     scheme from architecture §8.2.
   - `metadata.size` equals the byte length of the written content.
   - `metadata.created_at` equals the value returned by the injected clock.
   - `metadata.producer = { job, step, attempt }`.

4. **M4 Index Append (FP-ART-INDEX)**
   - `appendArtifactIndex` creates `<runDir>/artifacts.jsonl` on first call
     and writes the metadata as one JSON line followed by a newline.
   - Calling `appendArtifactIndex` a second time appends without rewriting
     the previous line — the file MUST contain both entries in insertion
     order, separated by `\n`.
   - Each line is valid JSON that round-trips back to a structurally-equal
     metadata object.

5. **M5 Retry Attempt Isolation (FP-ART-RETRY)**
   - Writing artifact `(job=j, step=s, attempt=1, filename=stdout.log)` and
     subsequently `(job=j, step=s, attempt=2, filename=stdout.log)` produces
     two distinct files at different paths.
   - Re-reading attempt 1's file after attempt 2 completes returns the
     original attempt-1 content unchanged.
   - Both metadata entries are appendable to `artifacts.jsonl` and coexist.

## Spec Compliance Matrix

mvp-contracts.md §2.5 MUST clauses plus the architecture §8.2 path-safety
rules. RC numbers continue from WF-P3-DAG's RC-D2.

| #     | Clause (origin)                                                                              | Status                  |
| ----- | -------------------------------------------------------------------------------------------- | ----------------------- |
| RC-A1 | Artifact metadata MUST include `id` (mvp-contracts §2.5)                                     | Covered by FP-ART-WRITE |
| RC-A2 | Artifact metadata MUST include `run_id` (mvp-contracts §2.5)                                 | Covered by FP-ART-WRITE |
| RC-A3 | Artifact metadata MUST include `producer` (mvp-contracts §2.5)                               | Covered by FP-ART-WRITE |
| RC-A4 | Artifact metadata MUST include `kind` (mvp-contracts §2.5)                                   | Covered by FP-ART-WRITE |
| RC-A5 | Artifact metadata MUST include `path` (mvp-contracts §2.5)                                   | Covered by FP-ART-WRITE |
| RC-A6 | Artifact metadata MUST include `content_type` (mvp-contracts §2.5)                           | Covered by FP-ART-WRITE |
| RC-A7 | Artifact metadata MUST include `size` (mvp-contracts §2.5)                                   | Covered by FP-ART-WRITE |
| RC-A8 | Artifact metadata MUST include `summary` (mvp-contracts §2.5)                                | Covered by FP-ART-WRITE |
| RC-A9 | Artifact metadata MUST include `created_at` (mvp-contracts §2.5)                             | Covered by FP-ART-WRITE |
| RC-A10 | Artifact path MUST be a safe relative path within run directory (mvp-contracts §2.5, arch §8.2) | Covered by FP-ART-SAFE + FP-ART-PATH |
| RC-A11 | Absolute paths MUST be rejected (mvp-contracts §2.5, arch §8.2)                              | Covered by FP-ART-SAFE  |
| RC-A12 | `..` traversal escaping run directory MUST be rejected (mvp-contracts §2.5, arch §8.2)       | Covered by FP-ART-SAFE  |
| RC-A13 | Symlinks pointing outside run directory MUST be rejected (mvp-contracts §2.5, arch §8.2)     | Deferred to Step 2 — see Test Gaps |
| RC-A14 | Retry MUST NOT overwrite historical attempt artifacts (mvp-contracts §2.5)                   | Covered by FP-ART-RETRY |
| RC-A15 | `artifacts.jsonl` is an append-only run-level index (prd §16, arch §8.1)                     | Covered by FP-ART-INDEX |

Slice within 15-spec-clause budget (15 / max 15).

## Functional Points

| FP id         | Area                          | Source                        | Summary                                                                              |
| ------------- | ----------------------------- | ----------------------------- | ------------------------------------------------------------------------------------ |
| FP-ART-SAFE   | Path-safety guard             | mvp-contracts §2.5, arch §8.2 | `assertPathSafe(runDir, relPath)` rejects empty, absolute, escaping paths            |
| FP-ART-PATH   | Path allocation               | prd §16, arch §8.1            | `artifactPath(runDir, job, attempt, step, filename)` returns the canonical path      |
| FP-ART-WRITE  | Artifact write + metadata     | mvp-contracts §2.5, arch §8.2 | `writeArtifact(opts)` writes content and returns the full ArtifactMetadata           |
| FP-ART-INDEX  | Append-only index             | prd §16, arch §8.1            | `appendArtifactIndex(runDir, metadata)` appends a JSON line to `artifacts.jsonl`     |
| FP-ART-RETRY  | Retry attempt isolation       | mvp-contracts §2.5            | attempt-N writes do not overwrite attempt-(N-1) artifacts; paths differ by attempt   |

## Use Cases

| UC id        | Actor | Trigger                                                                       | Pre-conditions                                | Steps (happy path)                                                                                              | Post-conditions / observable result                                                            |
| ------------ | ----- | ----------------------------------------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| UC-SAFE-1    | Lib   | `assertPathSafe(runDir, "jobs/a/attempts/1/steps/b/stdout.log")`              | `runDir` is a real tmp dir                    | Resolve relPath against runDir; verify result starts with runDir.                                              | Returns `void` without throwing.                                                              |
| UC-SAFE-2    | Lib   | `assertPathSafe(runDir, "")`                                                  | empty relPath                                 | Length check rejects.                                                                                          | Throws `ArtifactError` with kind `ArtifactError`.                                              |
| UC-SAFE-3    | Lib   | `assertPathSafe(runDir, "/etc/passwd")`                                       | absolute POSIX path                           | `path.isAbsolute` returns true; reject.                                                                        | Throws `ArtifactError`.                                                                       |
| UC-SAFE-4    | Lib   | `assertPathSafe(runDir, "../escape")`                                         | traversal that escapes runDir                 | Resolve yields path outside runDir; reject.                                                                    | Throws `ArtifactError`.                                                                       |
| UC-SAFE-5    | Lib   | `assertPathSafe(runDir, "jobs/a/../a/file.log")`                              | mid-path `..` that stays inside runDir        | Resolve yields path inside runDir; accept.                                                                     | Returns `void`.                                                                               |
| UC-PATH-1    | Lib   | `artifactPath(runDir, "build", 1, "compile", "stdout.log")`                   | runDir exists                                 | Join `runDir, "jobs", "build", "attempts", "1", "steps", "compile", "stdout.log"`.                              | Returns `<runDir>/jobs/build/attempts/1/steps/compile/stdout.log`.                            |
| UC-PATH-2    | Lib   | `artifactPath(runDir, "j", 2, "s", "f.txt")`                                  | any runDir                                    | Path-relative check: relative to runDir equals `jobs/j/attempts/2/steps/s/f.txt`.                              | Relative path matches the §16 pattern.                                                        |
| UC-WRITE-1   | Lib   | `writeArtifact({ runDir, runId, job, attempt, step, kind, filename, content, contentType, summary })` | tmp runDir, all fields set            | Allocate path; mkdir -p step dir; write content; assemble metadata.                                            | File exists with content; metadata contains all 9 required fields.                            |
| UC-WRITE-2   | Lib   | `writeArtifact` with `content = "hello world"` (11 bytes)                     | tmp runDir                                    | Compute byte length.                                                                                           | `metadata.size === 11`.                                                                       |
| UC-WRITE-3   | Lib   | `writeArtifact` with injected fixed clock returning `"2026-06-08T00:00:00Z"` | tmp runDir, FakeClock                          | Call `clock.now()` once.                                                                                       | `metadata.created_at === "2026-06-08T00:00:00Z"`.                                              |
| UC-WRITE-4   | Lib   | `writeArtifact` with `runId="20260608-0001"`, `job="j"`, `step="s"`, `attempt=1`, `filename="stdout.log"` | tmp runDir | Construct id.                                                                                              | `metadata.id === "artifact://20260608-0001/jobs/j/attempts/1/steps/s/stdout"` (architecture §8.2 stem). |
| UC-INDEX-1   | Lib   | `appendArtifactIndex(runDir, m1)` on a fresh runDir                           | `artifacts.jsonl` does not yet exist          | Append JSON line + `\n`.                                                                                       | File exists with one line that JSON-parses to `m1`.                                            |
| UC-INDEX-2   | Lib   | Sequential `appendArtifactIndex(runDir, m1)` then `appendArtifactIndex(runDir, m2)` | runDir tmp                              | Two appends.                                                                                                   | File contains two lines in insertion order, each JSON-parsing to its respective metadata.      |
| UC-RETRY-1   | Lib   | Two `writeArtifact` calls with identical (job, step, filename) but attempts 1 and 2 | tmp runDir                              | Distinct paths under `attempts/1` and `attempts/2`.                                                            | Both files exist; attempt-1 file content unchanged after attempt-2 write.                     |

## Test Mapping

| Test id     | File                              | Test name                                                                                                | UCs covered           | FPs covered    |
| ----------- | --------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------- | -------------- |
| T-SAFE-1    | `tests/artifact/artifact.test.ts` | `assertPathSafe accepts a safe relative path under runDir`                                              | UC-SAFE-1             | FP-ART-SAFE    |
| T-SAFE-2    | `tests/artifact/artifact.test.ts` | `assertPathSafe rejects empty string with ArtifactError`                                                | UC-SAFE-2             | FP-ART-SAFE    |
| T-SAFE-3    | `tests/artifact/artifact.test.ts` | `assertPathSafe rejects absolute path with ArtifactError`                                               | UC-SAFE-3             | FP-ART-SAFE    |
| T-SAFE-4    | `tests/artifact/artifact.test.ts` | `assertPathSafe rejects .. traversal that escapes runDir with ArtifactError`                           | UC-SAFE-4             | FP-ART-SAFE    |
| T-SAFE-5    | `tests/artifact/artifact.test.ts` | `assertPathSafe accepts mid-path .. that resolves inside runDir`                                       | UC-SAFE-5             | FP-ART-SAFE    |
| T-PATH-1    | `tests/artifact/artifact.test.ts` | `artifactPath returns runDir-joined jobs/<job>/attempts/<n>/steps/<step>/<file> path`                  | UC-PATH-1             | FP-ART-PATH    |
| T-PATH-2    | `tests/artifact/artifact.test.ts` | `artifactPath output is within runDir`                                                                  | UC-PATH-2             | FP-ART-PATH    |
| T-WRITE-1   | `tests/artifact/artifact.test.ts` | `writeArtifact writes file with the provided content`                                                  | UC-WRITE-1            | FP-ART-WRITE   |
| T-WRITE-2   | `tests/artifact/artifact.test.ts` | `writeArtifact returns metadata with all required fields`                                              | UC-WRITE-1            | FP-ART-WRITE   |
| T-WRITE-3   | `tests/artifact/artifact.test.ts` | `writeArtifact returns metadata.size equal to content byte length`                                     | UC-WRITE-2            | FP-ART-WRITE   |
| T-WRITE-4   | `tests/artifact/artifact.test.ts` | `writeArtifact uses injected clock for created_at`                                                     | UC-WRITE-3            | FP-ART-WRITE   |
| T-WRITE-5   | `tests/artifact/artifact.test.ts` | `writeArtifact returns metadata.id following artifact:// scheme`                                       | UC-WRITE-4            | FP-ART-WRITE   |
| T-WRITE-6   | `tests/artifact/artifact.test.ts` | `writeArtifact returns metadata.path as relative POSIX-style path`                                     | UC-WRITE-1            | FP-ART-WRITE   |
| T-INDEX-1   | `tests/artifact/artifact.test.ts` | `appendArtifactIndex creates artifacts.jsonl on first call`                                            | UC-INDEX-1            | FP-ART-INDEX   |
| T-INDEX-2   | `tests/artifact/artifact.test.ts` | `appendArtifactIndex preserves existing entries when appending`                                        | UC-INDEX-2            | FP-ART-INDEX   |
| T-RETRY-1   | `tests/artifact/artifact.test.ts` | `attempt 1 and attempt 2 of same job/step produce different paths`                                     | UC-RETRY-1            | FP-ART-RETRY   |
| T-RETRY-2   | `tests/artifact/artifact.test.ts` | `attempt 2 write does not overwrite attempt 1 file`                                                    | UC-RETRY-1            | FP-ART-RETRY   |

## Test Design Summary

- **Test framework**: vitest (`describe`, `it`, `expect`, `beforeEach`,
  `afterEach`).
- **Imports**: from `../../src/artifact/index.js` for the unit under test;
  from `../../src/utils/index.js` for `ArtifactError`. No imports from
  `src/run`, `src/events`, or any consumer module.
- **Filesystem**: real tmp directories under `os.tmpdir()` with
  `node:crypto.randomUUID()` suffixes — not fs mocks. Each test creates and
  tears down its own runDir to keep tests independent and parallel-safe.
- **Clock injection**: tests that assert `created_at` pass a `FakeClock`
  returning a fixed ISO 8601 string. Tests that do not assert `created_at`
  may use a `SystemClock`-style adapter.
- **Assertions**: error tests use `await expect(...).rejects.toThrow(ArtifactError)`
  (or the sync `expect(() => ...).toThrow(ArtifactError)` form). Metadata
  assertions check field presence and value separately; the `id` test
  asserts the exact string per architecture §8.2.
- **Red phase**: tests will not compile until Step 2 supplies
  `src/artifact/index.ts` with exported `assertPathSafe`, `artifactPath`,
  `writeArtifact`, `appendArtifactIndex`, `ArtifactMetadata` and `Clock`
  types. That is expected.

## Test Gaps

- **Symlink rejection (RC-A13)**: detecting symlinks that point outside
  `runDir` requires `fs.realpath` and a created-symlink fixture. Symlink
  creation requires Administrator privileges on Windows. Defer to Step 2
  acceptance tests run under a POSIX CI lane; record residual risk in the
  Step 2 PR if Windows coverage cannot be added.
- **Concurrent writers**: two simultaneous `appendArtifactIndex` calls to
  the same `artifacts.jsonl` are not tested here — POSIX `O_APPEND` provides
  the guarantee on supported platforms; explicit lock testing belongs to a
  later phase if multi-writer scenarios appear.
- **`content_type` inference**: `writeArtifact` accepts `contentType`
  explicitly; auto-inference from filename extension is out of scope for MVP.
- **Large content streaming**: MVP writes via a single
  `writeFile(content)` call. Streaming for content >100MB is deferred.
- **Engine integration**: wiring `writeArtifact` into Script Step / Agent
  Step is reserved for P5 (Context Builder + Script execution). End-to-end
  tests covering "Script Step writes stdout.log -> artifact appears in
  artifacts.jsonl" belong to that phase.
- **Schema validator (Zod) round-trip**: the development plan mentions a
  Zod validator on `ArtifactMetadata`; round-trip parsing tests are
  bundled with the metadata-shape assertions here. A dedicated
  `artifactMetadata.test.ts` is unnecessary at MVP scope.
