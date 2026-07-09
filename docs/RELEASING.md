# Releasing FreeFrame

FreeFrame uses **moving branch pointers** on top of immutable `vX.Y.Z` tags so
self-hosters can track a known-good version instead of `main`.

| Ref | Moves? | Who moves it | For |
|-----|--------|--------------|-----|
| `main` | every merge | contributors | development |
| `vX.Y.Z` | never | release cutter (manual tag) | permanent history / pinning |
| `latest` | every release | **`release-pointers.yml`** (auto) | early adopters |
| `stable` | on promotion | **`promote-stable.yml`** (manual) | production self-hosters |

## Cutting a release

1. Make sure `main` is green and the `CHANGELOG.md` `[Unreleased]` section is
   complete. Move those entries under a new `## [X.Y.Z] - YYYY-MM-DD` heading.
2. Tag the release commit and push the tag:
   ```bash
   git tag vX.Y.Z <commit>      # usually main's HEAD
   git push origin vX.Y.Z
   ```
3. Publish a **GitHub Release** for `vX.Y.Z` with notes (the CHANGELOG section).
   - Publishing it triggers `release-pointers.yml`, which **auto-moves `latest`**
     to `vX.Y.Z`. (Mark it a *pre-release* to keep `latest` where it is.)

## Promoting to `stable`

`latest` moves immediately; `stable` moves only after you've validated the
release (soak it as `latest`, smoke-test, watch for breakage reports).

- Run the **"Promote release to stable"** workflow (Actions → Run workflow) with
  `tag: vX.Y.Z`.
- It **refuses to promote unless that tag's commit passed CI** (≥1 check-run and
  all `success`). Use `force: true` only for a tag that legitimately has no CI
  (e.g. docs-only).

## Rolling back a bad release

`stable` is just a pointer — move it back to the last good tag:

- Run **"Promote release to stable"** again with the previous good `tag`
  (e.g. `v1.3.0`).
- Optionally edit the bad GitHub Release to mark it clearly broken. The
  immutable `vX.Y.Z` tag stays as-is; only the `stable` pointer retreats.

## One-time setup (already done)

- `stable` and `latest` branches were created at **v1.3.1**.
- `latest`/`stable` must **not** have required-review branch protection, or the
  workflows' `GITHUB_TOKEN` (`contents: write`) can't push them. Only `main` is
  protected.
- Moving `latest`/`stable` does **not** run `ci.yml` (it triggers on
  `push: branches: [main]` only), so there's no CI storm and no trigger loop.
