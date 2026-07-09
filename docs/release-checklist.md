# Release Checklist

This document describes the manual steps for publishing a new version of Zigma Flow to the npm registry. The process is currently manual; automated CI/CD release workflows are planned for a future phase.

---

## 1. Pre-Release Verification

Before cutting a release, verify the working tree is clean and all gates pass.

- [ ] Ensure the working tree is clean: `git status` shows no uncommitted changes.
- [ ] Run typecheck: `npx tsc --noEmit` (no errors).
- [ ] Run lint: `npx tsc --noEmit` (covers lint via strict TypeScript checking).
- [ ] Run the full test suite: `npx vitest run` (all tests pass).
- [ ] Run smoke test: `node dist/cli.js --help` exits 0 and prints usage. Rebuild with `npx tsup` if `dist/` is stale.
- [ ] Verify CI is green on the target branch (main): `gh run list --limit 3 --branch main`.
- [ ] Confirm the package is ready for publishing: `npm pack --dry-run` lists the expected files (dist/, docs/wiki, LICENSE, package.json, README.md).

## 2. Version Bump

Choose the appropriate semver increment based on changes since the last release:

- **patch** -- Bug fixes, documentation, test changes only.
- **minor** -- New features, experimental field changes, new step types.
- **major** -- Breaking changes to stable fields (not expected before v1.0).

Update the version in `package.json`:

```bash
# Option A: using npm (recommended)
npm version patch    # or minor, or major
# This creates a git commit and tag automatically.
# Note: npm version will also add an "v" prefix to the tag.

# Option B: manual update
# Edit version field in package.json directly.
git add package.json
git commit -m "chore: bump version to X.Y.Z"
git tag vX.Y.Z
```

## 3. CHANGELOG Update

- [ ] Add a new `## [vX.Y.Z]` section at the top of `CHANGELOG.md` with the release date in ISO format.
- [ ] List all notable changes under the new section, classified with the appropriate tags (`[runtime]`, `[DSL]`, `[CLI]`, `[docs]`, `[tests]`, `[breaking]`).
- [ ] Review the git log since the last tag to ensure no changes are missed: `git log --oneline <previous-tag>..HEAD --no-decorate`.
- [ ] Commit the CHANGELOG update: `git add CHANGELOG.md && git commit -m "docs: update CHANGELOG for vX.Y.Z"`.

## 4. Git Tag Creation

If `npm version` was used above, the tag already exists. Otherwise:

```bash
git tag -a vX.Y.Z -m "Release vX.Y.Z"
git push origin vX.Y.Z
```

Verify the tag was pushed:

```bash
git tag --list 'v*' | sort -V
```

## 5. npm Publish

Zigma Flow is published as a scoped public package under `@zigma/zigma-flow`.

```bash
# Ensure you are logged in to npm as a member of the @zigma org.
npm whoami

# Publish the package.
npm publish --access public
```

**First-time publish setup** (if the package has not been published before):

1. Create an npm account and request membership in the `@zigma` npm organization.
2. Log in: `npm login`.
3. Verify: `npm whoami` prints your npm username.
4. Publish as above.

## 6. GitHub Release

- [ ] Create a GitHub Release for the new tag:
  ```bash
  gh release create vX.Y.Z --title "vX.Y.Z" --notes "See CHANGELOG.md for details."
  ```
- [ ] Verify the release appears at https://github.com/LummiGhost/zigma-flow/releases.

## 7. Post-Release Verification

- [ ] Verify the package is installable: `npm view @zigma/zigma-flow versions --json`.
- [ ] Verify CI on the default branch succeeds for the release commit: `gh run list --limit 3 --branch main`.
- [ ] Confirm the GitHub Release shows the correct tag and assets.

## Notes

- The `@zigma` npm org must exist and the publishing user must be a member with write access. This is a one-time setup task.
- All releases should be cut from the `main` branch after CI is green.
- If a release fails during publish (e.g., network error), fix the issue and retry. Do not change the version number for a retry.
- For emergency hotfixes, create a `hotfix/x.y.z` branch from the affected tag, apply the fix, and follow the same checklist.
