"""The quality ladder is configuration now, so a typo must not cost every upload.

The failure this guards against is specific: an unrecognised rung name was
dropped without a word, and a value where every name was unrecognised produced
`split=0` with an empty `-var_stream_map`. ffmpeg rejects that, so one typo in
the setting failed every video through the whole Celery retry ladder before
landing at `failed` -- with nothing anywhere pointing at the setting.
"""
import pytest

from packages.transcoder.ffmpeg_transcoder import (
    DEFAULT_QUALITIES, QUALITY_MAP, parse_qualities,
)


# ------------------------------------------------------------------ the happy path

def test_the_default_is_the_ladder_that_was_hardcoded_before():
    assert parse_qualities("1080p,720p,360p") == ["1080p", "720p", "360p"]
    assert list(DEFAULT_QUALITIES) == ["1080p", "720p", "360p"]


def test_a_single_rung_is_honoured():
    assert parse_qualities("720p") == ["720p"]


def test_whitespace_and_empty_entries_are_tolerated():
    # Pasted from a compose file, this is what an operator actually types.
    assert parse_qualities(" 1080p , 360p ,, ") == ["1080p", "360p"]


def test_order_follows_the_ladder_not_the_typing():
    # The order decides the variant indices in the manifest, so it must not
    # depend on how the operator happened to type the list.
    assert parse_qualities("360p,1080p") == ["1080p", "360p"]


def test_a_repeated_rung_is_not_built_twice():
    assert parse_qualities("720p,720p") == ["720p"]


# --------------------------------------------------------------- the typo cases

def test_an_unknown_rung_is_dropped_and_reported(capsys):
    assert parse_qualities("1080p,240p") == ["1080p"]
    said = capsys.readouterr().out
    assert "240p" in said
    # The message has to name what would have worked, or it only reports that
    # something was wrong without saying what.
    assert all(q in said for q in QUALITY_MAP)


def test_an_all_invalid_value_falls_back_to_the_default_and_says_so(capsys):
    # This is the case that used to break every upload: nothing valid left,
    # `split=0`, ffmpeg refuses.
    assert parse_qualities("1080,720,360") == list(DEFAULT_QUALITIES)
    assert "falling back" in capsys.readouterr().out


@pytest.mark.parametrize("raw", ["", "   ", ",,", None])
def test_an_empty_setting_is_the_default_without_a_warning(raw, capsys):
    # Not a typo -- an unset value. Warning about it would train people to
    # ignore the warnings that matter.
    assert parse_qualities(raw) == list(DEFAULT_QUALITIES)
    assert capsys.readouterr().out == ""


# ------------------------------------------------------- the guard at the far end

def test_the_transcoder_never_receives_an_empty_ladder():
    """`parse_qualities` guards the configured path; the consumer guards the rest.

    A TranscodeJob can be built by any caller, and `qualities` has a plain list
    default, so the line that filters against QUALITY_MAP has to survive junk
    reaching it from somewhere other than the setting.
    """
    import inspect
    from packages.transcoder.ffmpeg_transcoder import FFmpegTranscoder
    src = inspect.getsource(FFmpegTranscoder.transcode)
    assert "or list(DEFAULT_QUALITIES)" in src, (
        "the fallback at the filtering site is what stops split=0"
    )
