#!/usr/bin/env python3
"""GHCR tag decisions for .github/workflows/publish-images.yml.

Kept out of the workflow's shell so the rules are unit-tested
(apps/api/tests/test_release_image_tags.py). Standard library only: the
workflow runs it on a bare runner Python.

Tags for a release vX.Y.Z (docs/RELEASING.md):
  X.Y.Z, vX.Y.Z  always
  X.Y            non-prerelease, and only if no newer X.Y patch is released
  latest         non-prerelease, and only if it is GitHub's latest release

Usage:
  image_tags.py <tag> --prerelease <true|false> --latest <true|false>
                [--releases-file FILE]
      Print the tags to publish, one per line. FILE lists published,
      non-draft release tags one per line; with it, X.Y is only included
      when <tag> is the newest patch of its line.

  image_tags.py repoint <tag> --tags-file FILE --digests-file FILE
      Print the aliases (X.Y, latest, stable) a rebuild of <tag> must move to
      the new digest: those not being published anyway that still point at
      <tag>'s old digest. The digests file holds `alias<TAB>digest` lines
      recorded before the push, with an empty digest for a missing tag.
"""
from __future__ import annotations

import argparse
import re
import sys

# vX.Y.Z with an optional SemVer pre-release suffix. No build metadata: `+` is
# not allowed in a Docker tag.
_TAG = re.compile(r"^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z]+(?:\.[0-9A-Za-z-]+)*))?$")


def _parse(tag: str) -> tuple[int, int, int, str | None]:
    match = _TAG.match(tag)
    if not match:
        raise ValueError(f"release tag must look like vX.Y.Z or vX.Y.Z-suffix, got {tag!r}")
    major, minor, patch, pre = match.groups()
    return int(major), int(minor), int(patch), pre


def compute_tags(version: str, prerelease: bool, is_latest: bool, newest_in_line: bool = True) -> list[str]:
    """Image tags to publish for release tag `version` (for example `v1.22.0`)."""
    major, minor, _patch, pre = _parse(version)
    bare = version[1:]
    tags = [bare, version]
    # A suffixed version is a prerelease whatever the release's checkbox says,
    # so an unticked v1.23.0-rc.1 can never take `1.23` or `latest`.
    if prerelease or pre is not None:
        return tags
    if newest_in_line:
        tags.append(f"{major}.{minor}")
    if is_latest:
        tags.append("latest")
    return tags


def is_newest_in_line(tag: str, releases: list[str]) -> bool:
    """True when no released, non-prerelease patch of tag's X.Y line is newer.

    Entries of `releases` that are not vX.Y.Z (prereleases, other naming) are
    ignored, and `tag` itself need not be in the list.
    """
    major, minor, patch, _pre = _parse(tag)
    for other in releases:
        try:
            o_major, o_minor, o_patch, o_pre = _parse(other.strip())
        except ValueError:
            continue
        if o_pre is None and (o_major, o_minor) == (major, minor) and o_patch > patch:
            return False
    return True


def aliases_to_repoint(version: str, tags: list[str], current: dict[str, str | None]) -> list[str]:
    """Aliases a rebuild of `version` must move to the new digest.

    `current` maps tag -> digest (None or "" when the tag does not exist),
    recorded before anything was pushed. An alias is moved only when it is
    not in `tags` (those are pushed anyway) and still points at the old
    digest of `version`, so an alias that had already moved on to a newer
    release is left alone, and a missing alias is never created.
    """
    major, minor, _patch, _pre = _parse(version)
    old = current.get(version[1:])
    if not old:
        return []
    candidates = [f"{major}.{minor}", "latest", "stable"]
    return [alias for alias in candidates if alias not in tags and current.get(alias) == old]


def _bool(value: str) -> bool:
    if value == "true":
        return True
    if value == "false":
        return False
    raise argparse.ArgumentTypeError(f"expected true or false, got {value!r}")


def _lines(path: str) -> list[str]:
    with open(path, encoding="utf-8") as handle:
        return [line.strip() for line in handle if line.strip()]


def _main_tags(argv: list[str]) -> list[str]:
    parser = argparse.ArgumentParser(prog="image_tags.py")
    parser.add_argument("tag")
    parser.add_argument("--prerelease", type=_bool, required=True)
    parser.add_argument("--latest", type=_bool, required=True)
    parser.add_argument("--releases-file")
    args = parser.parse_args(argv)
    newest = True
    if args.releases_file:
        newest = is_newest_in_line(args.tag, _lines(args.releases_file))
    return compute_tags(args.tag, args.prerelease, args.latest, newest_in_line=newest)


def _main_repoint(argv: list[str]) -> list[str]:
    parser = argparse.ArgumentParser(prog="image_tags.py repoint")
    parser.add_argument("tag")
    parser.add_argument("--tags-file", required=True)
    parser.add_argument("--digests-file", required=True)
    args = parser.parse_args(argv)
    current: dict[str, str | None] = {}
    with open(args.digests_file, encoding="utf-8") as handle:
        for line in handle:
            line = line.rstrip("\n")
            if not line:
                continue
            alias, _, digest = line.partition("\t")
            current[alias.strip()] = digest.strip() or None
    return aliases_to_repoint(args.tag, _lines(args.tags_file), current)


def main(argv: list[str]) -> int:
    try:
        if argv[:1] == ["repoint"]:
            out = _main_repoint(argv[1:])
        else:
            out = _main_tags(argv)
    except ValueError as exc:
        print(f"image_tags.py: {exc}", file=sys.stderr)
        return 2
    for line in out:
        print(line)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
