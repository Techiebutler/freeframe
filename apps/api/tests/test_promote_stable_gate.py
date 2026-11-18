"""The promote-stable CI gate reads every page of the tag commit's check-runs.

GitHub's check-runs API returns 30 per page. Read without pagination, a commit
with more check-runs than that (CI plus the publish jobs) shows only the first
page, so a failed check on a later page let `stable` move. The gate's own shell
runs here against a fake `gh` that serves two pages, as `gh api --paginate`
prints them (one JSON object per page, back to back), and a fake `git`.
"""
import json
import os
import pathlib
import shutil
import subprocess

import pytest
import yaml

WORKFLOW = pathlib.Path(__file__).resolve().parents[3] / ".github" / "workflows" / "promote-stable.yml"

# The dev API container mounts only apps/api, so the workflow is not there.
if not WORKFLOW.exists():
    pytest.skip(f"{WORKFLOW} is not in this tree (run from a full checkout)", allow_module_level=True)
if shutil.which("jq") is None or shutil.which("bash") is None:
    pytest.skip("the gate needs bash and jq", allow_module_level=True)

GATE_STEP = "Verify CI is green, then move `stable`"


def _gate_script() -> str:
    jobs = yaml.safe_load(WORKFLOW.read_text())["jobs"]
    for job in jobs.values():
        for step in job.get("steps", []):
            if step.get("name") == GATE_STEP:
                return step["run"]
    raise AssertionError(f"no step named {GATE_STEP!r} in {WORKFLOW}")


def _page(names_and_conclusions):
    return {
        "total_count": 31,
        "check_runs": [{"name": n, "status": "completed", "conclusion": c} for n, c in names_and_conclusions],
    }


def _run_gate(tmp_path, pages):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    pages_file = tmp_path / "pages.json"
    # What `gh api --paginate` prints: each page's object, one after another.
    pages_file.write_text("".join(json.dumps(p) for p in pages))
    first_file = tmp_path / "first.json"
    first_file.write_text(json.dumps(pages[0]))
    pushed = tmp_path / "pushed"
    (bin_dir / "gh").write_text(
        "#!/usr/bin/env bash\n"
        'for a in "$@"; do [ "$a" = --paginate ] && exec cat "$PAGES"; done\n'
        'exec cat "$FIRST"\n'
    )
    (bin_dir / "git").write_text(
        "#!/usr/bin/env bash\n"
        'case $1 in\n'
        "  rev-list) echo 0123456789abcdef0123456789abcdef01234567 ;;\n"
        '  push) echo "$*" >"$PUSHED" ;;\n'
        "esac\n"
    )
    for f in ("gh", "git"):
        (bin_dir / f).chmod(0o755)
    env = {
        **os.environ,
        "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
        "TAG": "v1.22.0",
        "FORCE": "false",
        "GH_TOKEN": "x",
        "GITHUB_REPOSITORY": "Techiebutler/freeframe",
        "PAGES": str(pages_file),
        "FIRST": str(first_file),
        "PUSHED": str(pushed),
    }
    result = subprocess.run(
        ["bash", "-c", _gate_script()], env=env, capture_output=True, text=True, timeout=30
    )
    return result, pushed.exists()


def test_a_failed_check_on_the_second_page_refuses_the_promotion(tmp_path):
    page1 = _page([(f"job-{i}", "success") for i in range(30)])
    page2 = _page([("build (linux/arm64)", "failure")])
    result, pushed = _run_gate(tmp_path, [page1, page2])
    assert result.returncode == 1, result.stdout + result.stderr
    assert "build (linux/arm64): failure" in result.stdout
    assert not pushed


def test_every_page_green_promotes_and_counts_them_all(tmp_path):
    page1 = _page([(f"job-{i}", "success") for i in range(30)])
    page2 = _page([("build (linux/arm64)", "success"), ("promote", "in_progress")])
    result, pushed = _run_gate(tmp_path, [page1, page2])
    assert result.returncode == 0, result.stdout + result.stderr
    # The gate's own `promote` check-run is left out of the count.
    assert "All 31 CI check(s) green" in result.stdout
    assert pushed
