"""TRANSCODER_AUDIO_BITRATE has to reach every audio stream ffmpeg writes (#328).

Left alone, the HLS muxer picks the audio encoding itself: native AAC-LC at
about 128 kb/s for a stereo source. Nobody chose that number and nothing said
what it was, which is the wrong default for a review stream of a final mix.
Unset must stay exactly that, so an upgrade that touches no configuration
writes the same command it wrote before.
"""
import pytest

from apps.api.tests.test_source_copy import _transcode
from packages.transcoder import ffmpeg_transcoder

_STEREO_PCM = [{"codec_name": "pcm_s16le", "channels": 2}]
_DEFAULT_LADDER = ["1080p", "720p", "360p"]


def _audio_options(cmd: list[str]) -> list[str]:
    return [a for a in cmd if a.startswith(("-c:a", "-b:a"))]


def _encode_cmd(audio_streams=_STEREO_PCM) -> list[str]:
    cmd, _, _ = _transcode(_DEFAULT_LADDER, audio_streams=audio_streams, source_copy=None)
    return cmd


# ─────────────────────────────────── parsing

@pytest.mark.parametrize("raw, expected", [
    ("320k", "320k"),
    ("192K", "192k"),
    (" 256k ", "256k"),
    ("64k", "64k"),
    ("512k", "512k"),
])
def test_a_usable_bitrate_is_taken_as_given(raw, expected):
    assert ffmpeg_transcoder.parse_audio_bitrate(raw) == expected


@pytest.mark.parametrize("raw", [None, "", "   "])
def test_unset_means_ffmpeg_s_own_default(raw, capsys):
    assert ffmpeg_transcoder.parse_audio_bitrate(raw) is None
    assert capsys.readouterr().out == ""


@pytest.mark.parametrize("raw", ["loud", "320", "320000", "320kb", "5000k", "32k", "0k", "-128k"])
def test_an_unusable_value_falls_back_and_says_so(raw, capsys):
    # "320" would reach ffmpeg as 320 bits per second, so a bare number is
    # refused rather than guessed at.
    assert ffmpeg_transcoder.parse_audio_bitrate(raw) is None
    assert "TRANSCODER_AUDIO_BITRATE" in capsys.readouterr().out


def test_get_audio_bitrate_reads_the_environment(monkeypatch):
    monkeypatch.setenv("TRANSCODER_AUDIO_BITRATE", "320k")
    assert ffmpeg_transcoder.get_audio_bitrate() == "320k"
    monkeypatch.delenv("TRANSCODER_AUDIO_BITRATE")
    assert ffmpeg_transcoder.get_audio_bitrate() is None


# ─────────────────────────────────── the encoded ladder

def test_a_configured_bitrate_reaches_every_rung(monkeypatch):
    monkeypatch.setenv("TRANSCODER_AUDIO_BITRATE", "320k")
    cmd = _encode_cmd()

    # Indexed per audio stream, one per rung. An unindexed `-b:a` happens to
    # work while every rung shares one value, which is the trap #393 fell into
    # for `-crf`, so the index is pinned here rather than left to luck.
    assert _audio_options(cmd) == [
        "-c:a:0", "-b:a:0", "-c:a:1", "-b:a:1", "-c:a:2", "-b:a:2",
    ]
    for i in range(3):
        assert cmd[cmd.index(f"-c:a:{i}") + 1] == "aac"
        assert cmd[cmd.index(f"-b:a:{i}") + 1] == "320k"


def test_unset_leaves_the_command_as_it_was(monkeypatch):
    monkeypatch.delenv("TRANSCODER_AUDIO_BITRATE", raising=False)
    assert _audio_options(_encode_cmd()) == []


def test_an_unusable_value_leaves_the_command_as_it_was(monkeypatch, capsys):
    # A typo costs a line in the log, not every upload on the instance.
    monkeypatch.setenv("TRANSCODER_AUDIO_BITRATE", "loud")
    assert _audio_options(_encode_cmd()) == []
    assert "TRANSCODER_AUDIO_BITRATE" in capsys.readouterr().out


def test_a_silent_source_gets_no_audio_options(monkeypatch):
    monkeypatch.setenv("TRANSCODER_AUDIO_BITRATE", "320k")
    assert _audio_options(_encode_cmd(audio_streams=[])) == []


# ─────────────────────────────────── the stream copy

def test_a_copy_converts_pcm_at_the_configured_bitrate(monkeypatch):
    monkeypatch.setenv("TRANSCODER_AUDIO_BITRATE", "320k")
    cmd, _, _ = _transcode(["1080p"], audio_streams=_STEREO_PCM)

    assert cmd[cmd.index("-c:v") + 1] == "copy"
    assert cmd[cmd.index("-c:a") + 1] == "aac"
    assert cmd[cmd.index("-b:a") + 1] == "320k"


def test_a_copy_keeps_its_192k_when_nothing_is_configured(monkeypatch):
    monkeypatch.delenv("TRANSCODER_AUDIO_BITRATE", raising=False)
    cmd, _, _ = _transcode(["1080p"], audio_streams=_STEREO_PCM)

    assert cmd[cmd.index("-b:a") + 1] == "192k"


def test_a_copy_still_carries_aac_untouched_when_a_bitrate_is_configured(monkeypatch):
    # Re-encoding AAC to reach a number can only lose quality, never add it.
    monkeypatch.setenv("TRANSCODER_AUDIO_BITRATE", "320k")
    cmd, _, _ = _transcode(["1080p"], audio_streams=[{"codec_name": "aac"}])

    assert cmd[cmd.index("-c:a") + 1] == "copy"
    assert "-b:a" not in cmd
