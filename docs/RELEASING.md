# Releasing FreeFrame

FreeFrame uses **moving branch pointers** on top of immutable `vX.Y.Z` tags so
self-hosters can track a known-good version instead of `main`.

| Ref | Moves? | Who moves it | For |
|-----|--------|--------------|-----|
| `main` | every merge | contributors | development |
| `vX.Y.Z` | never | release cutter (manual tag) | permanent history / pinning |
| `latest` | every release | **`publish-images.yml`** (auto, after both images are published) | early adopters |
| `stable` | on promotion | **`promote-stable.yml`** (manual) | production self-hosters |

Each release also publishes two multi-arch images (`linux/amd64` and
`linux/arm64`), `ghcr.io/techiebutler/freeframe-api` and
`ghcr.io/techiebutler/freeframe-web`, whose tags follow the refs:

| Image tag | Moves? | Who moves it |
|-----------|--------|--------------|
| `X.Y.Z` and `vX.Y.Z` | never to new source (a rebuild only refreshes the base image) | `publish-images.yml` |
| `X.Y` | with each newer patch of that line | `publish-images.yml` |
| `latest` | with the `latest` branch | `publish-images.yml`, only for GitHub's latest release |
| `stable` | with the `stable` branch | `promote-stable.yml`, the promoted tag's exact digest |

Releases before v1.21.0 have no images.

## Cutting a release

1. Make sure `main` is green and the `CHANGELOG.md` `[Unreleased]` section is
   complete. Move those entries under a new `## [X.Y.Z] - YYYY-MM-DD` heading.
   - **Credit external contributors.** For every PR in this release authored by
     someone other than the maintainer, check the entry it added has a trailing
     `(#NNN by @handle)`, and make sure that handle appears in a `### Contributors`
     line at the end of the version's section — *every* contributor from this
     release goes there, even ones whose PR had no user-facing entry of its own
     (test infra, internal refactors, etc.). Nobody who had a PR merged this
     release should be invisible in the CHANGELOG.
   - **Bump the `docker-compose.images.yml` default to `X.Y.Z`** (no `v`) in the
     same release PR; CI fails otherwise. The release PR is no longer
     CHANGELOG-only, so CI runs on it.
2. Tag the release commit and push the tag:
   ```bash
   git tag vX.Y.Z <commit>      # usually main's HEAD
   git push origin vX.Y.Z
   ```
3. Publish a **GitHub Release** for `vX.Y.Z` with notes (the CHANGELOG section,
   `### Contributors` line included — the release notes are where a contributor's
   name actually gets seen, so don't drop it here even if you trim anything else).
   - Publishing it triggers `publish-images.yml`, which builds both images on
     amd64 and arm64, tags them, attests them, and then **auto-moves `latest`**
     (the branch and the image tag) to `vX.Y.Z`, but only when `vX.Y.Z` is
     GitHub's latest release. A *pre-release* gets only its `X.Y.Z` and
     `vX.Y.Z` image tags and moves nothing.
   - Publishing a patch for an older line (say v1.20.3 after v1.21.0)? Use
     `gh release create v1.20.3 --latest=false` so GitHub does not mark it the
     latest release. It then gets `1.20.3`, `v1.20.3` and `1.20`, and `latest`
     stays put.
   - A backport tag cut from a branch that predates `publish-images.yml`
     triggers nothing when its release is published (the release event runs
     the workflow file at the tag's commit), so run "Publish images" for it by
     hand. Worse, such a branch still has the old `release-pointers.yml`,
     which would move the `latest` branch to the backport: delete that file
     on the branch before tagging.
   - If an image fails to build, `latest` (branch and image tag) stays where
     it was. For a transient failure (a registry or network error), open the
     release's own "Publish images" run under Actions and use **Re-run failed
     jobs**. Do not start a new run with "Run workflow" for this: a
     workflow_dispatch run registers its check-runs on main's HEAD, not on the
     tag's commit, so the original run's failed check-runs stay on the tag
     commit and "Promote release to stable" refuses the tag. If the original
     run cannot succeed when re-run, publish with "Run workflow" (below) and
     promote that tag with `force: true` once you have checked that its CI run
     passed (`force` skips the whole CI gate).

## Rebuilding or backfilling images

Run the **"Publish images"** workflow (Actions, Run workflow) with
`tag: vX.Y.Z`. It builds that tag's commit and overwrites the version's own
tags. `X.Y`, `latest` and `stable` move to the rebuilt image only where they
still pointed at that version's previous image, so a rebuild never takes them
from a newer release. Use it to backfill a release that has no images, or to
pick up a base-image security fix. For a release whose own run failed, re-run
that run's failed jobs instead (see "Cutting a release").

Check where an image came from with:

```bash
gh attestation verify oci://ghcr.io/techiebutler/freeframe-api:vX.Y.Z --repo Techiebutler/freeframe
```

## Promoting to `stable`

`latest` moves as soon as the release's images are published; `stable` moves only after you've validated the
release (soak it as `latest`, smoke-test, watch for breakage reports).

- Run the **"Promote release to stable"** workflow (Actions → Run workflow) with
  `tag: vX.Y.Z`.
- It **refuses to promote unless that tag's commit passed CI** (≥1 check-run and
  all `success`). Use `force: true` only for a tag that legitimately has no CI
  (e.g. docs-only).
- It **moves the branch and the `stable` image tag together.** Before anything
  moves it checks that both images exist for `vX.Y.Z`, and refuses if they do
  not (run "Publish images" for that tag first). After moving the branch it
  points `stable` on both images at the exact digest of `vX.Y.Z` (a retag, not
  a rebuild) and checks they match. If that last step fails, re-run the
  workflow with the same tag; repeating it is harmless.

**The docs install from `stable`.** The install command in the README and
`docs/deployment.md` is
`sudo FREEFRAME_CHANNEL=stable bash -c "$(curl -fsSL .../stable/install.sh)"`,
and the published-images download commands there use the `stable` ref too
(since v1.22.1, the first release with the installer promoted there). Keep
`FREEFRAME_CHANNEL=stable` in every stable command: `install.sh` cannot see the
URL it was downloaded from, and both it and the `freeframe` command default to
`latest` when no channel is given, so a bare `bash -c` of the stable URL
installs a server that follows `latest`. Keep the
`bash -c` form: a piped `curl ... | sudo bash` cannot ask its questions under
sudo-rs (Ubuntu 26.04), and install.sh stops it.

## Rolling back a bad release

`stable` is just a pointer — move it back to the last good tag:

- Run **"Promote release to stable"** again with the previous good `tag`
  (e.g. `v1.3.0`).
- Rolling back to a release from before images were published (anything older
  than v1.21.0) needs `branch_only: true`. It moves the branch and leaves the
  `stable` image tag where it was; those releases' compose files build from
  source and never read it. It is refused for a tag that has published images.
- Optionally edit the bad GitHub Release to mark it clearly broken. The
  immutable `vX.Y.Z` tag stays as-is; only the `stable` pointer retreats.

## One-time setup (already done)

- The GHCR packages `freeframe-api` and `freeframe-web` are public, so an
  anonymous `docker pull` works. GitHub creates a package as private and has
  no API to change that; if a new package is ever added, make it public by
  hand after its first push (org Packages, the package, Package settings,
  Change visibility), or the published-images compose files and the installer
  fail to pull it.

- `stable` and `latest` branches were created at **v1.3.1**.
- `latest`/`stable` must **not** have required-review branch protection, or the
  workflows' `GITHUB_TOKEN` (`contents: write`) can't push them. Only `main` is
  protected.
- Moving `latest`/`stable` does **not** run `ci.yml` (it triggers on
  `push: branches: [main]` only), so there's no CI storm and no trigger loop.
