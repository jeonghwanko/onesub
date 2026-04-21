# Changesets

This directory holds pending version/changelog entries for `@onesub/*` packages. Changesets is the single source of truth for what goes into the next release.

## Workflow

When your PR changes a published package (`@onesub/shared`, `@onesub/server`, `@jeonghwanko/onesub-sdk`, `@onesub/mcp-server`):

```bash
npm run changeset
```

- Pick the packages you changed.
- Pick the bump type:
  - **patch** — bug fixes, internal refactors, no API change
  - **minor** — new features, additive API, non-breaking
  - **major** — breaking change (also add an entry to `docs/MIGRATION.md`)
- Write a one-line summary — this becomes the CHANGELOG entry.

Commit the generated `.changeset/*.md` file with your PR.

## What happens on merge

When the PR merges to `master`:

1. The `Release` workflow runs. If there are pending changesets, it opens (or updates) a **"Version Packages"** PR that:
   - Consumes all `.changeset/*.md` files
   - Bumps each affected `package.json` version
   - Updates each package's `CHANGELOG.md`
2. When that PR is merged, the workflow publishes the bumped packages to npm.

## You do **not** need to

- Manually bump `version` in `package.json`
- Manually write entries in the root `CHANGELOG.md` (it stays as a historical archive; per-package `CHANGELOG.md` is auto-generated going forward)
- Coordinate cross-package version bumps by hand — internal dep updates are handled automatically (`updateInternalDependencies: "patch"`)

## Skipping changesets

Docs-only, test-only, CI-only, or `examples/*` changes don't need a changeset. The `Release` workflow simply no-ops when there's nothing to publish.
