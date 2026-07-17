# Compatibility Policy

## Stability Levels

Zigma Flow classifies every field in the Workflow Language Specification (`docs/workflow-language.md`) with one of three stability labels:

- **stable**: Fields won't be removed without a major version bump and deprecation period. Stable fields are fully supported, tested, and covered by the backward compatibility guarantee.
- **experimental**: Fields may change with a minor version bump; no deprecation period is guaranteed. Experimental fields are functional but their schema, semantics, or both may evolve.
- **reserved**: Recognised by the parser but not yet executable. Reserved fields and step types pass schema validation but produce a warning at runtime. They may be assigned any semantics in future versions without a breaking-change process.

These labels appear on every field in `docs/workflow-language.md` and are reflected in `@stability` annotations in the Zod schema (`src/workflow/index.ts`).

## Breaking Change Process for Stable Fields

When a stable field requires a breaking change, the following process must be followed:

1. Announce the breaking change in `CHANGELOG.md` with the planned removal version.
2. Add `@deprecated` annotation to the Zod schema field in `src/workflow/index.ts`.
3. Mark the field as deprecated in `docs/workflow-language.md`, noting the removal version.
4. Keep the field functional for at least one minor version after deprecation.
5. Remove in the next major version.

"Deprecated" is a transitional process state, not a formal stability level in the language spec. The three published stability levels remain stable, experimental, and reserved. A deprecated field retains its original stability label until removal; the deprecation annotation signals the intent to remove without adding a fourth label.

This process ensures workflow authors have time to migrate before stable fields are removed.

## Backward Compatibility Guarantee

- All workflows valid under v0.3–v0.6 must be valid under v0.7 without modification, unless the specific change is explicitly documented in `docs/migration.md`.
- **v0.7 internal translation:** Deprecated features (`goto_step`, `goto_job`, `retry_job`, `max_visits`, `on_failure` object form) are internally translated to the new Execution Model (Attempt, Job Group Iteration, failure_policy). They continue to work without any workflow changes.
- Validation errors on previously-valid workflows are treated as bugs and must be fixed in a patch release.
- New required fields added in a minor version must have a default value or be gated behind an opt-in mechanism. A workflow that omits a newly-added required field must not break.

This guarantee applies to **stable** fields. Experimental and deprecated fields may change in minor versions and are excluded from this guarantee.

## Versioning Convention

- **Major version** (1.0, 2.0): Breaking changes to stable fields. Workflow definitions written for one major version may not be valid under the next without migration.
- **Minor version** (0.3, 0.4): New features, experimental field changes, new step types, new validation rules for experimental fields. Stable fields are additive-only in minor releases.
- **Patch version** (0.2.1, 0.2.2): Bug fixes only. No schema changes, no new fields, no new validation rules. A patch release that rejects a previously-valid workflow is itself a bug.

## v0.7 Compatibility Verification

v0.7 extends backward compatibility with **internal translation** for all deprecated v0.6 features. The backward compat test suite (`tests/workflow/backward-compat-failure-policy.test.ts`, 238 lines) confirms:

- `on_failure` object form (`{ status: failed }`, `{ status: blocked }`) is correctly normalized to `failure_policy`
- v0.6 workflows using `goto_step`, `goto_job`, `retry_job`, `max_visits` are accepted and internally translated
- Implicit group creation (`__implicit__` prefix) for ungrouped jobs with goto/retry

Representative check using v0.6 workflows:

| Validation step | Result |
|-----------------|--------|
| YAML parse | Pass |
| Zod schema validation (new v0.7 fields: `job_groups`, `group`, `concurrency`, `failure_policy`, `retry.when`) | Pass |
| v0.6 workflow with `goto_step` / `goto_job` — accepted & translated | Pass |
| v0.6 workflow with `retry_job` / `retry_with` — accepted & translated | Pass |
| v0.6 workflow with `max_visits` — accepted & translated | Pass |
| v0.6 workflow with `on_failure` object form — accepted & normalized | Pass |
| DAG validation (including group-level `needs`) | Pass |
| New v0.7 workflow with `job_groups` + `repeat` + `concurrency` + `failure_policy` | Pass |
| Expression validation (new namespaces: `invocation`, `attempt`, `iteration.previous`) | Pass |
| Status functions pre-resolution (`success()`, `failure()`, `always()`, `cancelled()`) | Pass |

All v0.6 workflows are compatible with v0.7 without modification. Deprecated features produce runtime warnings (suppressible via `ZIGMA_SUPPRESS_DEPRECATION=1`) and will be removed in v1.0.
