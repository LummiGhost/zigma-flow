# WF-P6-RUNNER — Cases and Tests

- Workflow: WF-P6-RUNNER
- Phase: P6 Script Step
- Step: 1 (Cases and Tests)
- Date: 2026-06-08
- Author: subagent (workflow lead)

## Slice Boundary

- Slice name: WF-P6-RUNNER
- Bounded context: `ProcessRunner` port and the `ExecaProcessRunner` adapter.
  This workflow is pure subprocess execution — it produces a raw
  `ScriptRunResult` value and nothing else.
- Out of scope for this workflow (owned by WF-P6-SCRIPT):
  - Writing stdout/stderr as artifacts
  - Building the persisted `ScriptResult` JSON file
  - Emitting `step_started` / `script_completed` / `step_completed|failed`
    events
  - Mutating job / run state
  - Resolving step definitions (inline `run` vs Skill Pack `uses`)
- Planned test files (1 / max 1):
  - `tests/script/runner.test.ts` — integration tests for `ExecaProcessRunner`
    against real child processes (no subprocess mocking).

## Workflow Goal

Deliver a deterministic, cross-platform subprocess execution primitive for the
Script Step pipeline. The deliverable is the `ProcessRunner` port and its
`ExecaProcessRunner` adapter (both in `src/script/index.ts`), plus the
`ScriptError` class added to `src/utils/errors.ts`. The runner accepts a
command + options (`shell`, `cwd`, `env`, `timeoutMs`) and returns a raw
`ScriptRunResult` carrying `exitCode`, `timedOut`, captured `stdout` /
`stderr`, and the `started_at` / `ended_at` timestamps. Timeout is mapped to
POSIX convention `exitCode: 124` with `timedOut: true`. Spawn failure
(binary not found, permission denied, etc.) throws `ScriptError`. The
adapter does not touch artifacts, events, or state — that is WF-P6-SCRIPT's
responsibility.

## Module Layout

Implementation modules (created in Step 2; Step 1 only writes the test that
imports these symbols):

- `src/script/index.ts` exports:
  - Port: `ProcessRunner` interface (`run(opts): Promise<ScriptRunResult>`)
  - Adapter: `ExecaProcessRunner` class implementing `ProcessRunner`
  - Types: `ProcessRunOptions`, `ScriptRunResult`
- `src/utils/errors.ts` adds `ScriptError` (exit code 1) and re-exports it
  through `src/utils/index.ts`.

The test file uses
`import { ExecaProcessRunner, type ProcessRunner } from "../../src/script/index.js"`
and `import { ScriptError } from "../../src/utils/index.js"`.

## Raw Result Shape

```ts
interface ProcessRunOptions {
  command: string;            // single command string (shell mode)
  shell?: string | boolean;   // pass-through to execa; default true (use system shell)
  cwd?: string;               // working directory; defaults to process.cwd()
  env?: Record<string, string>; // extra env vars; merged onto process.env
  timeoutMs?: number;         // upper bound on wall-clock duration; no timeout if omitted
}

interface ScriptRunResult {
  exitCode: number;           // 0 on success; subprocess exit code on failure; 124 on timeout
  timedOut: boolean;          // true iff timeoutMs was exceeded and the process was killed
  stdout: string;             // raw captured stdout (may be empty)
  stderr: string;             // raw captured stderr (may be empty)
  started_at: string;         // ISO 8601 timestamp recorded before spawn
  ended_at: string;           // ISO 8601 timestamp recorded after subprocess settles
}
```

The runner never throws on non-zero exit codes or on timeout — both are
expressed in the returned `ScriptRunResult`. The runner DOES throw
`ScriptError` when the process cannot be spawned at all (binary not found,
permission denied, EACCES, ENOENT on the executable, etc.). The Engine
(in WF-P6-SCRIPT) decides whether to translate the result into
`step_completed` or `step_failed`.

## Use Case Enumeration

| UC id          | Actor | Trigger                                                                   | Pre-conditions                                                | Steps (happy path)                                                                                                  | Post-conditions / observable result                                                                                                                                                  |
| -------------- | ----- | ------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| UC-RUN-ZERO    | Lib   | `runner.run({ command: "echo hello" })`                                   | host shell available                                          | Capture `started_at`, spawn shell, run command, capture stdout/stderr, capture `ended_at`.                          | `exitCode === 0`; `timedOut === false`; `stdout` contains `"hello"`; `stderr === ""`; both timestamps are ISO 8601 strings; `ended_at >= started_at`.                                |
| UC-RUN-NONZERO | Lib   | `runner.run({ command: <portable exit-N command> })` with `N === 7`       | host shell available                                          | Spawn, observe non-zero exit.                                                                                       | `exitCode === 7`; `timedOut === false`; runner does NOT throw; result fields populated normally.                                                                                     |
| UC-RUN-STDERR  | Lib   | Command writes to stderr and exits non-zero (e.g. `node -e` with `console.error` + `process.exit(2)`) | node available                                                | Spawn, capture both streams.                                                                                        | `stderr` contains the expected text; `stdout` may be empty; `exitCode === 2`.                                                                                                        |
| UC-RUN-TIMEOUT | Lib   | `runner.run({ command: <sleeps for 5s>, timeoutMs: 200 })`                | host shell available                                          | Spawn, watchdog fires before subprocess settles, runner kills the child.                                            | `timedOut === true`; `exitCode === 124`; the call completes well before 5 s (under ~1 s in practice); runner does NOT throw.                                                         |
| UC-RUN-CWD     | Lib   | `runner.run({ command: <print cwd>, cwd: tmpDir })`                       | `tmpDir` is an existing absolute directory                    | Spawn with explicit cwd.                                                                                            | `stdout` (trimmed and `fs.realpathSync`-normalised) equals the absolute, realpath-normalised `tmpDir`; `exitCode === 0`. Both paths are realpath-normalised because Windows `os.tmpdir()` may return a short-name (8.3) path while the child reports the long-name. |
| UC-RUN-ENV     | Lib   | `runner.run({ command: <print env var>, env: { ZIGMA_TEST: "from-runner" } })` | host shell available                                          | Spawn with augmented env.                                                                                           | `stdout` contains `"from-runner"`; `exitCode === 0`. Existing process env vars (e.g. `PATH`) remain available (asserted indirectly by the command running at all).                   |
| UC-RUN-SPAWN-FAIL | Lib   | `runner.run({ command: "this-binary-definitely-does-not-exist-xyzzy", shell: false })` | no binary by that name on `PATH`                              | execa attempts to spawn, raises ENOENT.                                                                             | `runner.run` rejects with a `ScriptError` instance whose `kind === "ScriptError"`. The original spawn error is preserved on `error.cause`.                                            |
| UC-RUN-TIMING  | Lib   | Any successful run                                                        | none                                                          | Capture `started_at` before spawn; capture `ended_at` after subprocess settles or after the kill on timeout.        | `Date.parse(started_at)` and `Date.parse(ended_at)` are both non-NaN; `Date.parse(ended_at) >= Date.parse(started_at)`. (Asserted as part of UC-RUN-ZERO; not a separate test.)       |

### Functional Point Index

| FP id              | Area                                                | Source                  | Summary                                                                              |
| ------------------ | --------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------ |
| FP-RUNNER-PORT     | `ProcessRunner` port + `ScriptRunResult` shape      | Plan §4 WF-P6-RUNNER    | TypeScript interface other modules depend on; adapter-agnostic.                      |
| FP-RUNNER-EXEC0    | Zero-exit happy path                                | Plan §4 / arch §9.4     | Captures stdout, exitCode 0, both timestamps.                                        |
| FP-RUNNER-EXECN    | Non-zero exit                                       | Plan §4 / arch §9.4     | Captures exitCode, does not throw.                                                   |
| FP-RUNNER-STDERR   | Stderr capture                                      | mvp-contracts §2.7      | `stderr` carries the subprocess's stderr stream as a string.                         |
| FP-RUNNER-TIMEOUT  | Timeout enforcement (process killed, mapped to 124) | arch §10 / mvp §2.7     | `timedOut === true`, `exitCode === 124`; partial stdout/stderr is acceptable.        |
| FP-RUNNER-CWD      | `cwd` option respected                              | mvp-contracts §2.7      | Subprocess sees the requested working directory.                                     |
| FP-RUNNER-ENV      | `env` option merged onto host env                   | mvp-contracts §2.7      | Subprocess reads injected vars while still inheriting baseline env.                  |
| FP-RUNNER-SPAWN    | Spawn-failure path                                  | mvp-contracts §7 (ScriptError) | Throws `ScriptError`; preserves the underlying spawn error via `cause`.        |
| FP-RUNNER-TIMING   | `started_at` / `ended_at` timestamps                | arch §9.4               | Both captured by the runner; required fields in `ScriptRunResult`.                   |

## Spec Compliance Matrix

Authority sources: `docs/architecture.md` §9.4 (ScriptResult) and §10
(Quality Attribute Scenarios — script timeout row); `docs/mvp-contracts.md`
§2.7 (Script Result Contract) and §6 (ProcessRunner port row); §7 error
taxonomy (ScriptError).

| Clause ID | Clause Source                                | Clause Text (强制性 / MUST)                                                                                                                  | Status                                  |
| --------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| RC-RN01   | architecture §9.4 (ScriptResult schema)      | ScriptResult MUST carry `exit_code`, `timed_out`, `stdout`, `stderr`, `started_at`, `ended_at`. (Runner produces the raw fields.)             | 已纳入本工作流 (UC-RUN-ZERO + UC-RUN-TIMING) |
| RC-RN02   | architecture §10 (Quality Attribute — script timeout) | "ProcessRunner 终止进程，记录 timeout 和 stderr/stdout artifact" — runner must kill the child and surface a timeout result.                  | 已纳入本工作流 (UC-RUN-TIMEOUT)              |
| RC-RN03   | mvp-contracts §2.7 (Script Result Contract)  | "Script Step 必须支持 timeout、cwd、env、stdout / stderr capture 和 exit_code." — the runner is the only place these primitives live.        | 已纳入本工作流 (UC-RUN-ZERO, UC-RUN-NONZERO, UC-RUN-STDERR, UC-RUN-TIMEOUT, UC-RUN-CWD, UC-RUN-ENV) |
| RC-RN04   | mvp-contracts §2.7                           | "timeout 必须终止进程并记录失败结果." — timeout is a hard kill, not a soft signal, and produces a structured failure result.                  | 已纳入本工作流 (UC-RUN-TIMEOUT)              |
| RC-RN05   | mvp-contracts §2.7                           | "是否 continue、failed、retry 或 blocked 由 Engine 和 Gate 决定." — runner does not decide failure semantics, does not throw on non-zero exit. | 已纳入本工作流 (UC-RUN-NONZERO — asserts no throw) |
| RC-RN06   | mvp-contracts §6 (ProcessRunner port)        | ProcessRunner minimum capability: "执行命令、timeout、cwd、env、capture stdout/stderr". Typical adapter: execa.                              | 已纳入本工作流 (FP-RUNNER-PORT + all UC-RUN-*) |
| RC-RN07   | mvp-contracts §7 (ScriptError)               | "ScriptError ... 进程启动失败 ... 写入 ScriptResult, 由 Engine/Gate 决定状态." Runner throws ScriptError on spawn failure.                      | 已纳入本工作流 (UC-RUN-SPAWN-FAIL)            |
| RC-RN08   | architecture §10 (Portability row)           | "Windows/Linux/macOS 路径差异 ... 所有内部路径用规范化相对路径和 file URL 安全规则." — test commands must be portable.                          | 已纳入本工作流 (test design uses `node -e` / `process.platform` switches; no `/bin/sh` literal) |
| RC-RN09   | architecture §9.4 (ScriptResult — stdout/stderr) | stdout/stderr in the persisted result are artifact refs. Runner stage returns raw strings; conversion to artifact refs is WF-P6-SCRIPT.   | 不适用 (artifact ref conversion is WF-P6-SCRIPT) |
| RC-RN10   | architecture §13 phase 6 verification        | "timeout、cwd、env、stdout/stderr 和 exit_code 都写入 artifact." — full pipeline target including artifact write.                              | 不适用 (artifact write owned by WF-P6-SCRIPT; runner only produces raw fields) |
| RC-RN11   | architecture §11 (security)                  | "Script Step 默认需要 timeout." — Step Definition layer enforces a default; runner only honours the value passed in.                          | 不适用 (default enforcement owned by WF-P6-SCRIPT) |
| RC-RN12   | architecture §5.2 / mvp §2.3 (Engine state ownership) | Script and Check MUST NOT directly mutate job status; runner returns data only.                                                          | 已纳入本工作流 (asserted by absence — runner exports no state-write surface; covered by FP boundary, not a test case) |

12 clauses surveyed (9 in-scope, 3 out-of-scope but documented to make the
boundary explicit). All "已纳入本工作流" rows trace to at least one UC and one
T-RUNNER-N test below.

## Test Plan

All tests live in **`tests/script/runner.test.ts`** under
`describe("ExecaProcessRunner", ...)`. Vitest. Real subprocesses, no
subprocess mocking. Each test instantiates a fresh `new ExecaProcessRunner()`.

| Test id     | `it` description                                                       | What it verifies                                                                                                                                                                | UCs covered                       | FPs covered                              | RCs touched                  |
| ----------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ---------------------------------------- | ---------------------------- |
| T-RUNNER-1  | `returns exitCode 0 and captures stdout when the command succeeds`     | Run a portable `echo hello`. Assert `exitCode === 0`, `timedOut === false`, `stdout` contains `"hello"`, both `started_at` and `ended_at` are valid ISO 8601, `ended_at >= started_at`. | UC-RUN-ZERO, UC-RUN-TIMING        | FP-RUNNER-EXEC0, FP-RUNNER-TIMING        | RC-RN01, RC-RN03, RC-RN06    |
| T-RUNNER-2  | `returns the non-zero exitCode and captures stderr without throwing`   | Run a portable command that exits 7 and writes to stderr (`node -e "console.error('boom'); process.exit(7)"`). Assert `exitCode === 7`, `timedOut === false`, `stderr` contains `"boom"`, the call does NOT reject. | UC-RUN-NONZERO, UC-RUN-STDERR     | FP-RUNNER-EXECN, FP-RUNNER-STDERR        | RC-RN03, RC-RN05             |
| T-RUNNER-3  | `marks the result as timedOut with exitCode 124 when the timeout elapses` | Run a command that sleeps ~5 s (`node -e "setTimeout(()=>{}, 5000)"`) with `timeoutMs: 300`. Assert `timedOut === true`, `exitCode === 124`, the call resolves in well under 5 s (under 3 s in the test). | UC-RUN-TIMEOUT                    | FP-RUNNER-TIMEOUT                        | RC-RN02, RC-RN03, RC-RN04    |
| T-RUNNER-4  | `runs the command with the requested cwd`                              | Make a tmp dir; run a portable `print cwd` command (`node -e "process.stdout.write(process.cwd())"`) with `cwd: tmpDir`; assert the stdout (after `realpathSync` normalisation) equals `tmpDir` (also realpath-normalised). | UC-RUN-CWD                        | FP-RUNNER-CWD                            | RC-RN03                      |
| T-RUNNER-5  | `injects custom env vars and still inherits baseline env`              | Run `node -e "process.stdout.write(process.env.ZIGMA_TEST ?? '')"` with `env: { ZIGMA_TEST: "from-runner" }`. Assert stdout equals `"from-runner"` and `exitCode === 0` (which proves baseline `PATH` is inherited so `node` was findable). | UC-RUN-ENV                        | FP-RUNNER-ENV                            | RC-RN03                      |
| T-RUNNER-6  | `throws ScriptError when the binary cannot be spawned`                 | `runner.run({ command: "this-binary-definitely-does-not-exist-xyzzy", shell: false })`. Assert the call rejects with `instanceof ScriptError` and `err.kind === "ScriptError"`. | UC-RUN-SPAWN-FAIL                 | FP-RUNNER-SPAWN                          | RC-RN07                      |

## Test Design Notes

- **Framework**: vitest (`describe` / `it` / `expect`).
- **Subprocess strategy**: no mocking; spawn real processes. All commands use
  `node -e "..."` form (Node ≥ 20 is a project prerequisite per `package.json
  engines`), which sidesteps shell-syntax portability between PowerShell, cmd,
  bash, and zsh.
- **Cross-platform commands**:
  - Use `process.execPath` (the absolute path of the current node binary) for
    every `node -e` invocation so that PATH lookups never interfere with the
    test outcome.
  - For T-RUNNER-1 (`echo`), prefer `node -e "process.stdout.write('hello')"`
    over a shell `echo` to avoid quoting differences across shells.
  - For T-RUNNER-3 (sleep), use `node -e "setTimeout(()=>{}, 5000)"` rather
    than `sleep` or `timeout` (which are not uniformly available).
- **Tmp dir**: `os.tmpdir()` + `node:fs/promises.mkdtemp`; clean up in
  `afterEach`. UC-RUN-CWD normalises both the actual and expected paths
  through `fs.realpathSync` because Windows `os.tmpdir()` may yield a
  short-name (8.3) path while the child reports the long-name.
- **Timestamps**: assert via `Date.parse` (non-NaN) rather than full ISO regex,
  matching the convention already established in `tests/run/infrastructure.test.ts`.
- **Error assertions**: T-RUNNER-6 uses `expect(...).rejects.toThrow(ScriptError)`
  followed by an explicit `instanceof ScriptError` + `err.kind === "ScriptError"`
  check on the caught error, matching project convention (assert on the
  discriminator, not the message string).
- **Test timeout**: T-RUNNER-3 sets a per-test vitest timeout of 4 s; the
  assertion `expect(elapsed).toBeLessThan(3000)` proves the runner actually
  killed the subprocess rather than letting it complete.
- **Red phase**: this file will not compile because
  `src/script/index.ts` currently exports `{}` and `ScriptError` is not yet in
  `src/utils/errors.ts`. Both gaps are filled by Step 2.

## Test Gaps and Deferred Concerns

- **Partial stdout/stderr on timeout**: the spec ("捕获 partial stdout/stderr"
  per development plan §4) is honoured by execa naturally; we do not assert
  partial output explicitly because Node's `setTimeout` no-op test produces no
  output. WF-P6-SCRIPT integration tests can pick this up if needed.
- **Signal handling (SIGTERM vs SIGKILL)**: out of scope for MVP; execa's
  default kill behaviour is accepted.
- **Output size limits**: TD-P6-003 (stdout/stderr artifacts have no size
  limit) is accepted debt; the runner returns whatever the subprocess wrote.
- **Encoding**: execa default UTF-8 string mode is accepted. Binary stdout is
  out of scope for MVP.
- **Concurrent `runner.run` calls**: each call is independent; no shared
  state. Not asserted.
- **Skill Pack `uses` resolution**: owned by WF-P6-SCRIPT (D7 in the
  development plan). The runner only takes a `command` string.
