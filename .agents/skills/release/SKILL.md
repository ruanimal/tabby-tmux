---
name: release
description: Release tabby-tmux by updating version and changelog, validating, committing, tagging, and pushing. Use when asked to release a version or prepare a release for this repository.
---

# tabby-tmux Release

Complete the release through a version commit, tag, and push when the user requests a release (including `$release patch version`). That request authorizes these steps after validation; do not stop to ask for another confirmation. If the user explicitly requests preparation only or a dry run, stop after preparing and reviewing the files. Editing this skill alone is not a request to perform a release.

Read the repository `AGENTS.md`, `package.json`, `CHANGELOG.md`, and `.github/workflows/publish.yml` first. Use the actual git tags and commit history to establish the previous release and summarize user-visible changes; do not infer release contents from uncommitted or unrelated changes.

## Prepare the release

- Check `git status` before editing. Preserve existing user changes and include them only when the user identifies them as part of this release.
- Determine the next version from the requested version, current `package.json`, latest tag, and change scope. Follow SemVer; flag a version/tag mismatch instead of silently choosing one.
- Update `package.json`'s version and add a concise, user-facing entry to `CHANGELOG.md` in the repository's existing language and style. Include only changes since the previous release that belong to this release. Keep the changelog newest-first and use the release date only when known.
- Run the checks required by `AGENTS.md` and the project CI that are relevant to a release: lint, typecheck, format check, tests (including integration and performance checks when their dependencies are available), and build. Report checks that cannot run and why.
- Review the final diff, version, changelog, and working tree before committing.

## Commit, tag, and push

1. Stage only the release's version and changelog changes, inspect the staged diff, and commit using the repository's convention, for example `chore(release): prepare 1.6.1`. If the intended release changes are already committed, reuse that commit rather than making an empty commit or bumping the version again.
2. Create an annotated `v<version>` tag on the release commit, with the version matching `package.json`. Check local and remote tags first. Reuse an existing tag only if it points to the intended commit; stop on a conflicting tag instead of moving it.
3. Resolve the destination remote and branch from the current branch's upstream. Push the release commit to that branch first, then push the exact `v<version>` tag to the same remote. If the branch push fails, stop before pushing the tag. Do not push unrelated tags or force-push.
4. Verify the remote branch and tag point to the intended release commit. Report the version, commit, tag, push results, release contents, and validation results. A successful tag push means publishing was triggered; claim successful publication only after the workflow confirms it.

Pushing a `v*` tag triggers `.github/workflows/publish.yml`, which builds and publishes the package to npm and creates a GitHub Release. Complete all release checks before creating and pushing the tag. If validation fails, report the blocker and resolve it before proceeding with the release.

The workflow_dispatch `version` input currently does not update `package.json`; verify the package version and tag agree before publishing. The workflow writes generated commit notes to `CHANGELOG.md` in its CI checkout for the GitHub Release body. Maintain the tracked `CHANGELOG.md` as the project's version history; do not replace it with generated release notes.
