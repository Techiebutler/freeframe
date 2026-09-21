"""Each ladder rung has to be encoded at the quality computed for it (#393).

`-c:v:{i}` carries a stream specifier. `-crf` did not, and neither did
`-global_quality` on the hardware backends, so every iteration appended another
unqualified copy and ffmpeg applied the last one to every video stream. The
ladder runs largest rung first, so the last value is the smallest rung's, and
the 1080p rendition was encoded at the 360p rung's quality.

Measured on ffmpeg 7.1.1 with the exact command this code builds, a 6s 1080p
source, three rungs, comparing the shipped form against the stream-qualified
one:

    rung        as shipped      qualified     ratio
    1080p         1776 KB        4264 KB      2.40x
    720p           468 KB         812 KB      1.74x
    360p           160 KB         160 KB      1.00x

The last rung is the control: it is the one whose value survived, so it is
byte-identical either way, which is what identifies the mechanism rather than
merely showing a difference.

Worth knowing while reading this: ffmpeg warns about `-pix_fmt` here and says
nothing at all about `-crf`. The option it warns about carried the same value on
every rung and was harmless; the silent one is the one that changed the output.
So "no warnings" is not the property to test for. The per-rung value is.
"""
import pytest

from apps.api.tests.test_transcoder_cpu_budget_applied import _ffmpeg_cmd_for
from packages.transcoder.ffmpeg_transcoder import QUALITY_MAP

LADDER = ["1080p", "720p", "360p"]


def _values_for(cmd: list[str], option: str) -> dict[str, str]:
    """Every `{option}...` token in `cmd`, mapped to the value that follows it."""
    return {t: cmd[i + 1] for i, t in enumerate(cmd) if t.split(":")[0] == option}


def test_each_rung_carries_its_own_crf_on_the_software_encoder():
    # 8-bit H.264 is the default, and it encodes at the rung's CRF plus four.
    cmd = _ffmpeg_cmd_for(LADDER)

    assert _values_for(cmd, "-crf") == {
        f"-crf:v:{i}": str(QUALITY_MAP[q][1] + 4) for i, q in enumerate(LADDER)
    }


@pytest.mark.parametrize("backend", ["qsv", "vaapi"])
def test_each_rung_carries_its_own_global_quality_on_a_hardware_encoder(backend):
    # The same defect, in a branch #393 does not mention: qsv and vaapi spell
    # the rung's quality `-global_quality` and emitted 20, 22 and 26 unqualified,
    # so every rendition came out at 26.
    cmd = _ffmpeg_cmd_for(LADDER, backend=backend)

    assert _values_for(cmd, "-global_quality") == {
        f"-global_quality:v:{i}": str(QUALITY_MAP[q][1]) for i, q in enumerate(LADDER)
    }


def test_no_quality_option_is_left_without_a_stream_specifier():
    # The guard against the whole class rather than the two instances above: an
    # option emitted once per rung and applied to every stream is the shape of
    # this bug, and it is silent. A bare `-crf` anywhere means the last rung has
    # won again.
    for backend in (None, "nvenc", "qsv", "vaapi"):
        cmd = _ffmpeg_cmd_for(LADDER, backend=backend)
        bare = [t for t in cmd if t in ("-crf", "-global_quality", "-pix_fmt", "-qp",
                                        "-force_key_frames")]
        assert bare == [], f"{backend or 'cpu'} emits {bare} with no stream specifier"
