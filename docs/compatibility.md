# Compatibility Policy

## Stability Levels

Zigma Flow classifies every field in the Workflow Language Specification (`docs/workflow-language.md`) with one of four stability labels:

- **stable**: Fields won't be removed without a major version bump and deprecation period. Stable fields are fully supported, tested, and covered by the backward compatibility guarantee.
- **experimental**: Fields may change with a minor version bump; no deprecation period is guaranteed. Experimental fields are functional but their schema, semantics, or both may evolve.
- **reserved**: Recognised by the parser but not yet executable. Reserved fields and step types pass schema validation but produce a warning at runtime. They may be assigned any semantics in future versions without a breaking-change process.
- **deprecated**: Will be removed in the next major version. Deprecated fields remain functional during the deprecation window but emit a warning.

These labels appear on every field in `docs/workflow-language.md` and are reflected in `@stability` annotations in the Zod schema (`src/workflow/index.ts`).

## Breaking Change Process for Stable Fields

When a stable field requires a breaking change, the following process must be followed:

1. Announce the breaking change in `CHANGELOG.md` with the planned removal version.
2. Add `@deprecated` annotation to the Zod schema field in `src/workflow/index.ts`.
3. Mark the field as `deprecated` in `docs/workflow-language.md`, noting the removal version.
4. Keep the field functional for at least one minor version after deprecation.
5. Remove in the next major version.

This process ensures workflow authors have time to migrate before stable fields are removed.

## Backward Compatibility Guarantee

- All workflows valid under v0.2 must be valid under v0.3 without modification, unless the specific change is explicitly documented in `docs/migration.md`.
- Validation errors on previously-valid workflows are treated as bugs and must be fixed in a patch release.
- New required fields added in a minor version must have a default value or be gated behind an opt-in mechanism. A workflow that omits a newly-added required field must not break.

This guarantee applies to **stable** fields. Experimental fields may change in minor versions and are excluded from this guarantee.

## Versioning Convention

- **Major version** (1.0, 2.0): Breaking changes to stable fields. Workflow definitions written for one major version may not be valid under the next without migration.
- **Minor version** (0.3, 0.4): New features, experimental field changes, new step types, new validation rules for experimental fields. Stable fields are additive-only in minor releases.
- **Patch version** (0.2.1, 0.2.2): Bug fixes only. No schema changes, no new fields, no new validation rules. A patch release that rejects a previously-valid workflow is itself a bug.

## v0.2 Compatibility Verification

The v0.2 canonical workflow (`code-change.yml`) was validated against the v0.3 schema on 2026-07-03. Every field in the workflow is defined and accepted by the v0.3 Zod schema in `src/workflow/index.ts`. The workflow test suite (`tests/workflow/workflow.test.ts`, T-WF-1) confirms that the canonical workflow passes validation without errors.

| Validation step | Result |
|-----------------|--------|
| YAML parse | Pass |
| Zod schema validation (top-level fields: `name`, `version`, `on`, `skills`, `permissions`, `signals`, `jobs`) | Pass |
| Job schema validation (`steps`, `workspace`, `needs`, `optional_needs`, `activation`, `retry`) | Pass |
| Step schema validation (all step types: `agent`, `script`, `check`) | Pass |
| Signal schema validation (`severity`, `priority`, `allowed_from`, `action`) | Pass |
| DAG validation (no cycles, all references resolvable) | Pass |
| Skill alias validation (`expose.skills` declared in workflow `skills`) | Pass |

The v0.2 workflow uses only stable fields. No modifications are needed for v0.3 compatibility.
