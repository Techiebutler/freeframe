"""Which GHCR tags a release publishes, and which aliases a rebuild re-points.

`.github/scripts/image_tags.py` is run by `.github/workflows/publish-images.yml`.
It is not part of the API package, so it is loaded from its path here.

The rules (docs/RELEASING.md):
  * every release gets `X.Y.Z` and `vX.Y.Z`;
  * a non-prerelease also gets `X.Y`, unless a newer patch of that line is
    already released (so rebuilding v1.20.3 never drags `1.20` back from 1.20.4);
  * `latest` only when the release is GitHub's latest release;
  * a rebuild re-points `X.Y`, `latest` and `stable` only where they still
    point at the version's old digest.
"""
import importlib.util
import pathlib
import subprocess
import sys

import pytest

SCRIPT = pathlib.Path(__file__).resolve().parents[3] / ".github" / "scripts" / "image_tags.py"

# The dev API container mounts only apps/api and packages/transcoder, so the
# script is not there when the suite runs inside it (AGENTS.md's command).
if not SCRIPT.exists():
    pytest.skip(f"{SCRIPT} is not in this tree (run from a full checkout)", allow_module_level=True)


def _load():
    spec = importlib.util.spec_from_file_location("image_tags", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


image_tags = _load()


# --- compute_tags -----------------------------------------------------------


def test_latest_release_gets_every_tag():
    assert image_tags.compute_tags("v1.22.0", False, True) == ["1.22.0", "v1.22.0", "1.22", "latest"]


def test_backport_release_does_not_take_latest():
    assert image_tags.compute_tags("v1.20.3", False, False) == ["1.20.3", "v1.20.3", "1.20"]


def test_prerelease_gets_only_its_exact_tags():
    assert image_tags.compute_tags("v1.23.0-rc.1", True, False) == ["1.23.0-rc.1", "v1.23.0-rc.1"]


def test_prerelease_never_takes_latest_even_if_asked():
    assert image_tags.compute_tags("v1.23.0-rc.1", True, True) == ["1.23.0-rc.1", "v1.23.0-rc.1"]


def test_suffixed_version_is_a_prerelease_even_when_the_release_is_not_marked_one():
    # A release published as v1.23.0-rc.1 without the pre-release box ticked
    # must still not take `1.23` or `latest`.
    assert image_tags.compute_tags("v1.23.0-rc.1", False, True) == ["1.23.0-rc.1", "v1.23.0-rc.1"]


def test_older_patch_of_a_line_does_not_take_the_minor_alias():
    assert image_tags.compute_tags("v1.20.3", False, False, newest_in_line=False) == ["1.20.3", "v1.20.3"]


@pytest.mark.parametrize("tag", ["1.22.0", "v1.22", "v1", "", "latest", "v1.22.0+build.1", "v1.22.0-", "vv1.22.0", " v1.22.0"])
def test_malformed_tags_are_refused(tag):
    with pytest.raises(ValueError):
        image_tags.compute_tags(tag, False, False)


# --- is_newest_in_line ------------------------------------------------------


def test_newest_patch_of_its_line():
    assert image_tags.is_newest_in_line("v1.20.3", ["v1.21.0", "v1.20.3", "v1.20.2"]) is True


def test_newer_patch_already_released():
    assert image_tags.is_newest_in_line("v1.20.3", ["v1.21.0", "v1.20.4", "v1.20.3"]) is False


def test_patch_numbers_compare_as_numbers_not_strings():
    assert image_tags.is_newest_in_line("v1.20.10", ["v1.20.9", "v1.20.10"]) is True
    assert image_tags.is_newest_in_line("v1.20.9", ["v1.20.9", "v1.20.10"]) is False


def test_prereleases_and_junk_in_the_list_are_ignored():
    releases = ["v1.20.4-rc.1", "nightly", "", "1.20.9", "v1.20.3"]
    assert image_tags.is_newest_in_line("v1.20.3", releases) is True


def test_own_tag_missing_from_the_list_still_counts():
    # The release being published may not show in the list yet.
    assert image_tags.is_newest_in_line("v1.20.3", ["v1.20.2"]) is True


# --- aliases_to_repoint -----------------------------------------------------

OLD = "sha256:" + "a" * 64
OTHER = "sha256:" + "b" * 64


def test_first_publish_repoints_nothing():
    current = {"1.21.0": None, "1.21": OTHER, "latest": OTHER, "stable": OTHER}
    assert image_tags.aliases_to_repoint("v1.21.0", ["1.21.0", "v1.21.0", "1.21"], current) == []


def test_rebuild_repoints_aliases_still_on_the_old_digest():
    # v1.21.0 rebuilt after v1.22.0: `latest` moved on, `stable` is still v1.21.0.
    current = {"1.21.0": OLD, "1.21": OLD, "latest": OTHER, "stable": OLD}
    tags = image_tags.compute_tags("v1.21.0", False, False)
    assert image_tags.aliases_to_repoint("v1.21.0", tags, current) == ["stable"]


def test_rebuild_of_an_older_patch_repoints_the_minor_alias_only_if_it_was_still_there():
    tags = image_tags.compute_tags("v1.20.3", False, False, newest_in_line=False)
    on_old = {"1.20.3": OLD, "1.20": OLD, "latest": OTHER, "stable": OTHER}
    moved_on = {"1.20.3": OLD, "1.20": OTHER, "latest": OTHER, "stable": OTHER}
    assert image_tags.aliases_to_repoint("v1.20.3", tags, on_old) == ["1.20"]
    assert image_tags.aliases_to_repoint("v1.20.3", tags, moved_on) == []


def test_aliases_already_in_the_tag_list_are_not_repointed_twice():
    current = {"1.22.0": OLD, "1.22": OLD, "latest": OLD, "stable": OLD}
    tags = image_tags.compute_tags("v1.22.0", False, True)
    assert image_tags.aliases_to_repoint("v1.22.0", tags, current) == ["stable"]


def test_missing_aliases_are_never_created_by_a_repoint():
    current = {"1.22.0": OLD}
    assert image_tags.aliases_to_repoint("v1.22.0", ["1.22.0", "v1.22.0"], current) == []


# --- CLI ----------------------------------------------------------------------


def _run(*args, stdin=None):
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args], input=stdin, capture_output=True, text=True
    )


def test_cli_prints_one_tag_per_line():
    out = _run("v1.22.0", "--prerelease", "false", "--latest", "true")
    assert out.returncode == 0, out.stderr
    assert out.stdout.splitlines() == ["1.22.0", "v1.22.0", "1.22", "latest"]


def test_cli_drops_the_minor_alias_when_a_newer_patch_is_released(tmp_path):
    releases = tmp_path / "releases.txt"
    releases.write_text("v1.21.0\nv1.20.4\nv1.20.3\n")
    out = _run("v1.20.3", "--prerelease", "false", "--latest", "false", "--releases-file", str(releases))
    assert out.returncode == 0, out.stderr
    assert out.stdout.splitlines() == ["1.20.3", "v1.20.3"]


def test_cli_refuses_a_malformed_tag():
    out = _run("1.22.0", "--prerelease", "false", "--latest", "false")
    assert out.returncode != 0
    assert "1.22.0" in out.stderr


def test_cli_refuses_a_boolean_it_does_not_understand():
    out = _run("v1.22.0", "--prerelease", "yes", "--latest", "false")
    assert out.returncode != 0


def test_cli_repoint_reads_alias_digests(tmp_path):
    tags = tmp_path / "tags.txt"
    tags.write_text("1.21.0\nv1.21.0\n1.21\n")
    digests = tmp_path / "digests.txt"
    # alias<TAB>digest, empty digest for a tag that does not exist
    digests.write_text(f"1.21.0\t{OLD}\n1.21\t{OLD}\nlatest\t{OTHER}\nstable\t{OLD}\n")
    out = _run("repoint", "v1.21.0", "--tags-file", str(tags), "--digests-file", str(digests))
    assert out.returncode == 0, out.stderr
    assert out.stdout.splitlines() == ["stable"]


def test_cli_repoint_with_no_old_digest_prints_nothing(tmp_path):
    tags = tmp_path / "tags.txt"
    tags.write_text("1.21.0\nv1.21.0\n1.21\n")
    digests = tmp_path / "digests.txt"
    digests.write_text("1.21.0\t\n1.21\t\nlatest\t\nstable\t\n")
    out = _run("repoint", "v1.21.0", "--tags-file", str(tags), "--digests-file", str(digests))
    assert out.returncode == 0, out.stderr
    assert out.stdout == ""
