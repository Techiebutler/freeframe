"""The production web image reads its settings at runtime.

Next inlines every `process.env.NEXT_PUBLIC_*` that is set when `next build`
runs, into server code as well as the browser bundle. If the Dockerfile sets
NEXT_PUBLIC_UPLOAD_CONCURRENCY at build, the server's read of it is frozen into
the image and the value an operator puts in `.env.prod` is ignored. The base
path is fixed at build too, so the image refuses to start when it is given a
different one.
"""
import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
WEB_DOCKERFILE = REPO_ROOT / "apps/web/Dockerfile.prod"
ENTRYPOINT = "/usr/local/bin/ff-web-entrypoint"


def _instructions() -> list[str]:
    return [
        line.strip()
        for line in WEB_DOCKERFILE.read_text().splitlines()
        if line.strip() and not line.strip().startswith("#")
    ]


def test_web_dockerfile_does_not_bake_upload_concurrency():
    offenders = [
        line for line in _instructions() if "NEXT_PUBLIC_UPLOAD_CONCURRENCY" in line
    ]
    assert offenders == []


def test_web_dockerfile_runs_base_path_guard():
    instructions = _instructions()

    assert f'ENTRYPOINT ["{ENTRYPOINT}"]' in instructions
    assert 'CMD ["node", "server.js"]' in instructions
    # The guard has to be installed executable, whatever the git mode is, and
    # without COPY --chmod, which the legacy (non-BuildKit) builder refuses.
    assert not any("--chmod" in line for line in instructions)
    copy = [
        i
        for i, line in enumerate(instructions)
        if re.match(rf"COPY docker-entrypoint\.sh {re.escape(ENTRYPOINT)}$", line)
    ]
    chmod = [
        i
        for i, line in enumerate(instructions)
        if re.match(rf"RUN chmod 0?755 {re.escape(ENTRYPOINT)}$", line)
    ]
    user = [i for i, line in enumerate(instructions) if line == "USER nextjs"]
    assert len(copy) == 1 and len(chmod) == 1 and len(user) == 1
    # chmod runs as root, after the copy and before the switch to nextjs.
    assert copy[0] < chmod[0] < user[0]
