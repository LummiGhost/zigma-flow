# Codex CLI Backend Research

Research snapshot: Codex CLI `0.144.6`, captured 2026-07-27 with the installed
`codex --help` command tree.

## Command inventory

The CLI exposes these top-level commands: `exec`, `review`, `login`, `logout`,
`mcp`, `plugin`, `mcp-server`, `app-server`, `remote-control`, `app`,
`completion`, `update`, `doctor`, `sandbox`, `debug`, `apply`, `resume`,
`archive`, `delete`, `unarchive`, `fork`, `cloud`, `exec-server`, and
`features`. The interactive root also accepts a prompt and the common
configuration, model, profile, sandbox, approval, workspace, image, web-search,
remote-server, and feature-toggle options.

Only `exec` is suitable for a synchronous workflow backend. `review` is
repository-diff-specific; interactive/resume/fork commands own terminal
sessions; `app-server`, `mcp-server`, `exec-server`, and remote control are
long-lived protocols; cloud commands submit remote work rather than execute the
current Zigma step.

## Complete `codex exec` parameter surface

| Parameter | Purpose | Backend decision |
| --- | --- | --- |
| `[PROMPT]` or `-` | Prompt argument or stdin transport | Use `-` and stdin |
| `-c, --config key=value` | TOML config override | Use for approval and reasoning effort |
| `--enable`, `--disable` | Repeatable feature toggles | Available through custom `args` |
| `--strict-config` | Reject unknown config keys | Available through custom `args` |
| `-i, --image FILE...` | Attach images | Available through custom `args` |
| `-m, --model MODEL` | Model override | Native `model` config |
| `--oss` | Open-source provider | Available through custom `args` |
| `--local-provider` | `lmstudio` or `ollama` | Available through custom `args` |
| `-p, --profile PROFILE` | Layer a Codex config profile | Native `profile` config |
| `-s, --sandbox MODE` | `read-only`, `workspace-write`, or `danger-full-access` | Native `sandbox` config |
| `--dangerously-bypass-approvals-and-sandbox` | Disable both safety layers | Never enabled implicitly |
| `--dangerously-bypass-hook-trust` | Bypass persisted hook trust | Available only through explicit custom `args` |
| `-C, --cd DIR` | Set workspace root | Always set from `projectRoot` |
| `--add-dir DIR` | Add writable directory | Available through custom `args` |
| `--skip-git-repo-check` | Permit non-Git directories | Available through custom `args` |
| `--ephemeral` | Do not persist a session | Enabled by default |
| `--ignore-user-config` | Ignore base `config.toml` | Available through custom `args` |
| `--ignore-rules` | Ignore user/project exec-policy rules | Available through custom `args` |
| `--output-schema FILE` | Constrain final response with JSON Schema | Not used; strict schemas cannot preserve arbitrary workflow `outputs` keys |
| `--color MODE` | `always`, `never`, or `auto` | `never` for clean artifacts |
| `--json` | Emit JSONL events to stdout | Enabled for audit capture |
| `-o, --output-last-message FILE` | Write final assistant message to a file | Always targets canonical `report.json` |
| `-h, --help` | Help | Research only |
| `-V, --version` | Version | Doctor/research only |

`codex exec` also has `resume` and `review` subcommands. They are deliberately
not used because every Zigma Flow attempt must remain independently auditable
and must not inherit hidden conversation state.

## Prompt and context transport

The backend sends the already-composed Zigma Flow prompt through stdin. This
preserves the PromptPacket ordering (`system`, `task`, `step`, `context`,
`output`) without placing large or sensitive text in process arguments. It also
avoids Windows command-line length and quoting limits.

Codex receives the repository through `--cd <projectRoot>` and therefore loads
the repository's native instruction files normally. Zigma Flow does not copy
repository files into the prompt. Large logs and prior outputs remain artifact
references under the existing context policy.

The three output channels have distinct ownership:

- stdout: Codex JSONL event audit (`agent.stdout.log`);
- stderr: CLI diagnostics (`agent.stderr.log`);
- final response: canonical `report.json` through `--output-last-message`.

This separation prevents protocol JSONL from being parsed as the report and
lets the Engine remain the only component that accepts the report and advances
workflow state.

## Compatibility and risks

- Existing `claude-code` and custom backend behavior is unchanged.
- `codex-cli` is built in and works without a `backends.codex-cli` entry.
- CLI flags are version-sensitive. The tested baseline is recorded above;
  custom `args` can override or extend the invocation when future Codex
  versions add flags.
- Codex strict output schemas require closed object properties and therefore
  conflict with Zigma Flow's workflow-defined `outputs` object. The adapter
  deliberately leaves Engine report validation authoritative instead of
  silently rejecting dynamic output keys.
