"""What the API images install (#581).

Both API images installed ImageMagick and nothing ever called it: thumbnails,
posters, watermarks and transcodes all go through ffmpeg/ffprobe. The images are
shared by the API and every Celery service, so an unused copy was attack surface
and size in five containers.

gunicorn was installed unpinned in Dockerfile.prod while everything in
requirements.txt is pinned, so two builds of the same commit could ship
different gunicorn versions. The pin lives in requirements.txt now, so it is
covered by the pip entry in .github/dependabot.yml, which reads the
requirements files in apps/api and not the Dockerfiles.
"""
import re
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
DOCKERFILES = ("apps/api/Dockerfile", "apps/api/Dockerfile.prod")
REQUIREMENTS = REPO_ROOT / "apps/api/requirements.txt"


@pytest.mark.parametrize("dockerfile", DOCKERFILES)
def test_api_images_do_not_install_imagemagick(dockerfile):
    assert "imagemagick" not in (REPO_ROOT / dockerfile).read_text().lower()


def test_gunicorn_is_only_ever_installed_at_a_pinned_version():
    [pin] = [
        line.strip()
        for line in REQUIREMENTS.read_text().splitlines()
        if line.strip().startswith("gunicorn")
    ]
    assert re.fullmatch(r"gunicorn==\d+(\.\d+)*", pin), pin
    # And no image installs it a second time, which would be unpinned again.
    for dockerfile in DOCKERFILES:
        text = (REPO_ROOT / dockerfile).read_text()
        installs = [
            line
            for line in text.splitlines()
            if "pip install" in line and "gunicorn" in line
        ]
        assert installs == [], dockerfile
