"""A transcode that stops early must not be stored as a finished one.

The case behind this file, from a live instance: a 31:18 master came out as
1:37 of HLS, and the version was saved `ready` with the source's real duration
beside it. Nothing had gone wrong as far as the code could tell -- ffmpeg
exited 0 and the playlist carried `#EXT-X-ENDLIST` -- because exit code is the
only thing the transcoder looks at.

It is reachable whenever the input stops being readable part-way through: the
demuxer reaches what looks like the end of the file. Measured on the real
master, truncated at three successive frame boundaries, exit code 0 each time
with 92.4s, 96.1s and 99.8s of output. It is not confined to a clean boundary
either -- cut inside a video packet and the encode pipeline decodes through the
damage and still exits 0, and a dropped HTTP read logs `Input/output error`
before exiting 0. Only the copy pipeline reports it, exit 183 out of
`h264_mp4toannexb`, and there the remux-to-encoder fallback absorbs it and the
short ladder is stored anyway.

The two ways to get this wrong are not symmetric, and the asymmetry decides the
design. A ladder that is wrongly accepted can be rebuilt from a master that is
still there. A ladder that is wrongly refused on every read lands the version on
`failed`, and the stale-upload reaper then deletes the master -- the one copy
that cannot be rebuilt. So refusing is only ever worth a re-read: the check
refuses while an attempt remains and gives way, loudly, on the last one. What it
buys is the transient case, where reading again is the whole cure.

The same asymmetry runs through the metadata half of the file. Most containers
publish a number that looks like the video track's length and is not one, so
`video_track_seconds` declines far more often than it answers, and every
decline below is a file that must transcode unjudged rather than be refused.

Every claim here was checked by breaking the code and watching a test go red;
the mutations are listed in the pull request.
"""
import json
import os

import pytest

from packages.transcoder.ffmpeg_transcoder import (
    _PRIMARY_VIDEO_STREAM,
    TranscodeTruncated,
    hls_output_seconds,
    parse_probe_metadata,
    refuse_a_truncated_result,
)

# ffprobe reports the mov/mp4 family as one comma-joined list, and the exact
# string matters: it is the only family whose per-stream duration is trusted.
_MOV = "mov,mp4,m4a,3gp,3g2,mj2"
_MKV = "matroska,webm"
# The fragment of a refusal that no other failure produces. Asserted instead of
# a whole sentence so a reworded message is not a red test, and instead of the
# exception type because `transcode` turns every exception into a result.
_REFUSED = "of ladder against a"


def _variant(tmp_path, name: str, segment_seconds: list[float]):
    """Write a playlist the way the HLS muxer writes one."""
    d = tmp_path / name
    d.mkdir(parents=True, exist_ok=True)
    lines = ["#EXTM3U", "#EXT-X-VERSION:6", "#EXT-X-TARGETDURATION:3",
             "#EXT-X-PLAYLIST-TYPE:VOD"]
    for i, s in enumerate(segment_seconds):
        lines += [f"#EXTINF:{s:.6f},", f"seg_{i:03d}.ts"]
    lines.append("#EXT-X-ENDLIST")
    (d / "playlist.m3u8").write_text("\n".join(lines) + "\n")
    return d


# ----------------------------------------- which duration the check may use
#
# The subtle half of this feature, and the half that can lose a master. Three
# separate things all look like the video track's length and are not:
#
#   * a container's duration, which is its longest stream, so an audio tail
#     reports the audio;
#   * a per-stream duration the demuxer synthesised rather than measured -- ASF
#     copies the file's play duration onto every stream, AVI derives it from a
#     frame count that includes zero-size drop chunks and is a placeholder on a
#     piped file, MPEG-PS reports a PTS span that a clock jump inflates;
#   * a duration belonging to a stream the ladder does not encode, which is what
#     cover art is: `v:0`, one frame, handed the whole file's length.
#
# So the answer is narrow on purpose. `stream.duration` counts only from the
# mov/mp4 family, Matroska is read from its exact `DURATION` tag, and everything
# else declines. Declining is what `main` does, and being inert is the correct
# outcome for a check with nothing trustworthy to compare against.

def test_an_mp4_reports_the_same_duration_twice():
    # MP4 and MOV measure the track and mean it, so both numbers agree and the
    # distinction never shows. This is the common case, the case the incident
    # happened on, and the reason the rest of this section is easy to miss.
    meta = parse_probe_metadata({
        "streams": [{"duration": "600.000000", "width": 1920, "height": 1080,
                     "r_frame_rate": "25/1"}],
        "format": {"duration": "600.000000", "format_name": _MOV},
    })
    assert meta.duration_seconds == pytest.approx(600.0)
    assert meta.video_duration_seconds == pytest.approx(600.0)


@pytest.mark.parametrize("format_name, why", [
    ("asf", "ASF/WMV copies the file's play duration onto every stream, so a "
            "clip whose audio outlives its picture reports the audio for both"),
    ("avi", "AVI derives it from dwLength, which counts the zero-size drop "
            "chunks a held last frame is stored as, and which is a placeholder "
            "when the file was written to a pipe"),
    ("mpeg", "MPEG-PS reports the PTS span, which a clock jump between two "
             "spliced recordings inflates without a frame to show for it"),
    ("mpegts", "same, and a .mpg upload can be either"),
])
def test_a_stream_duration_from_another_demuxer_is_not_a_measurement(
    format_name, why
):
    # Each of these publishes a per-stream `duration` that looks exactly like
    # the mov/mp4 one and is not one. Trusting them refuses intact uploads of
    # three of the seven container types the product accepts -- and a refusal
    # that reproduces on every read costs the master.
    meta = parse_probe_metadata({
        "streams": [{"duration": "40.000000", "width": 640, "height": 480,
                     "r_frame_rate": "25/1"}],
        "format": {"duration": "40.000000", "format_name": format_name},
    })
    # Unchanged, because it reaches the database and the comment timecodes:
    assert meta.duration_seconds == pytest.approx(40.0)
    # But not offered as something to hold a ladder against:
    assert meta.video_duration_seconds is None, why


def test_a_wmv_whose_audio_outlives_its_picture_is_not_judged():
    # The concrete file behind the parametrisation above: 30s of picture, 40s of
    # audio, and the ASF demuxer reporting 40s for the video stream. Judging on
    # that number refuses a perfectly good upload at 75%.
    meta = parse_probe_metadata({
        "streams": [{"duration": "40.000000", "width": 640, "height": 480,
                     "r_frame_rate": "25/1", "start_time": "0.000000"}],
        "format": {"duration": "40.000000", "format_name": "asf"},
    })
    assert meta.video_duration_seconds is None


@pytest.mark.parametrize("format_name", [_MOV, _MKV])
def test_cover_art_has_no_timeline(format_name):
    # An audio file with artwork carries the picture as `v:0`, and the demuxer
    # gives that one frame the whole file's duration -- so a ladder of one frame
    # would be held against the album's length. mutagen writes `udta` ahead of
    # `trak`, so anything built on it (yt-dlp's embed-thumbnail, beets, Picard)
    # puts a real video in the same position.
    meta = parse_probe_metadata({
        "streams": [{"duration": "600.000000", "width": 600, "height": 600,
                     "r_frame_rate": "90000/1", "codec_name": "mjpeg",
                     "disposition": {"attached_pic": 1},
                     "tags": {"DURATION": "00:10:00.000000000"}}],
        "format": {"duration": "600.000000", "format_name": format_name},
    })
    assert meta.video_duration_seconds is None


def test_an_ordinary_video_stream_is_not_mistaken_for_cover_art():
    # The mirror, so the disposition check cannot be inverted or widened to
    # every disposition key without a test noticing.
    meta = parse_probe_metadata({
        "streams": [{"duration": "600.000000", "width": 1920, "height": 1080,
                     "r_frame_rate": "25/1",
                     "disposition": {"attached_pic": 0, "default": 1}}],
        "format": {"duration": "600.000000", "format_name": _MOV},
    })
    assert meta.video_duration_seconds == pytest.approx(600.0)


def test_matroska_reports_the_video_track_separately_from_the_file():
    # Measured on a real file built for this: a 20s picture with a 35s sine
    # muxed beside it. `ffprobe -select_streams v:0` on it gives exactly this --
    # no stream duration, DURATION as a tag, and the container reporting the
    # audio. An NLE rough cut and a MediaRecorder capture both produce it.
    meta = parse_probe_metadata({
        "streams": [{"width": 1920, "height": 1080, "r_frame_rate": "25/1",
                     "start_time": "0.000000",
                     "tags": {"DURATION": "00:00:20.023000000"}}],
        "format": {"duration": "35.023000", "format_name": _MKV},
    })
    # What the player, the database and the comment timecodes mean by "long":
    assert meta.duration_seconds == pytest.approx(35.023)
    # What an EXTINF sum may be compared against:
    assert meta.video_duration_seconds == pytest.approx(20.023)


def test_the_duration_tag_is_an_end_timestamp_and_the_offset_comes_off():
    # The correction that is easy to leave out and impossible to notice
    # afterwards. ffmpeg writes Matroska's DURATION as zero-to-last-packet, so
    # a picture that starts late reports more than it holds.
    #
    # Built with ffmpeg and probed: `-itsoffset 3` gives start_time 3.023 and
    # DURATION 00:00:33.023 for 750 packets at 25fps, which is 30.0s of
    # picture. Without the subtraction a complete ladder is refused at 91%.
    meta = parse_probe_metadata({
        "streams": [{"width": 320, "height": 240, "r_frame_rate": "25/1",
                     "start_time": "3.023000",
                     "tags": {"DURATION": "00:00:33.023000000"}}],
        "format": {"duration": "33.023000", "format_name": _MKV},
    })
    assert meta.video_duration_seconds == pytest.approx(30.0)


def test_an_mp4_duration_is_a_length_and_is_left_alone():
    # The mirror, and the reason the subtraction cannot simply be applied
    # everywhere: MP4's per-stream duration is a track length already.
    # Measured on the same `-itsoffset 3` source written as mp4: start_time
    # 3.000000 alongside duration 30.000000, and the 750 frames of its sample
    # table, which is what marks it as not fragmented.
    meta = parse_probe_metadata({
        "streams": [{"duration": "30.000000", "width": 320, "height": 240,
                     "r_frame_rate": "25/1", "start_time": "3.000000",
                     "nb_frames": "750"}],
        "format": {"duration": "33.000000", "format_name": _MOV},
    })
    assert meta.video_duration_seconds == pytest.approx(30.0)


def test_a_fragmented_mp4_duration_is_an_end_timestamp_and_the_offset_comes_off():
    # The exception to the rule above. A fragmented file keeps its samples in
    # the fragments, so `moov` has no sample table and ffprobe reports no
    # `nb_frames`, and the demuxer's duration runs to the end of the last
    # fragment from zero, not from the first `tfdt`. Measured on an HLS-fMP4
    # init segment joined to media segments 6-15 of a 60s stream: 1200 frames
    # at 30fps, 40s of picture. Read as a length, a complete ladder is refused
    # at 67% on every attempt but the last.
    meta = parse_probe_metadata({
        "streams": [{"duration": "60.000000", "width": 320, "height": 240,
                     "r_frame_rate": "30/1", "start_time": "20.066016"}],
        "format": {"duration": "60.053862", "format_name": _MOV},
    })
    assert meta.video_duration_seconds == pytest.approx(39.934, abs=0.001)


@pytest.mark.parametrize("duration", ["inf", "nan"])
def test_a_non_finite_mp4_duration_is_not_a_length(duration):
    # The Matroska tag and the playlist sum both guard this; the mov branch has
    # to as well, or `inf` would refuse every attempt but the last at 0%. (`nan`
    # is already refused by `> 0`; it is here so that stays true.)
    meta = parse_probe_metadata({
        "streams": [{"duration": duration, "width": 320, "height": 240,
                     "r_frame_rate": "25/1", "start_time": "0.000000",
                     "nb_frames": "750"}],
        "format": {"duration": "30.000000", "format_name": _MOV},
    })
    assert meta.video_duration_seconds is None


@pytest.mark.parametrize("nb_frames", ["0", "N/A", None])
def test_no_usable_frame_count_is_read_as_fragmented(nb_frames):
    stream = {"duration": "60.000000", "width": 320, "height": 240,
              "r_frame_rate": "30/1", "start_time": "20.0"}
    if nb_frames is not None:
        stream["nb_frames"] = nb_frames
    meta = parse_probe_metadata({
        "streams": [stream],
        "format": {"duration": "60.0", "format_name": _MOV},
    })
    assert meta.video_duration_seconds == pytest.approx(40.0)


def test_an_hour_long_duration_tag_is_read_as_hours():
    # Verified against a real 3700s Matroska, which reports
    # "DURATION": "01:01:40.000000000". Getting the hours multiplier wrong is
    # invisible on every short fixture and catastrophic on every long upload:
    # too large refuses each one permanently, too small switches the check off.
    meta = parse_probe_metadata({
        "streams": [{"width": 1920, "height": 1080, "r_frame_rate": "25/1",
                     "tags": {"DURATION": "01:01:40.000000000"}}],
        "format": {"duration": "3700.000000", "format_name": _MKV},
    })
    assert meta.video_duration_seconds == pytest.approx(3700.0)


def test_a_stale_language_suffixed_tag_does_not_win():
    # mkvmerge v45 and earlier wrote `DURATION-eng`. It survives a `-c copy` cut
    # into the new file, where it states the length of the file the cut came
    # from -- and ffprobe emits it first, so reading whichever `DURATION*` key
    # comes first lets a stale 120s beat the fresh 32s beside it. That refuses a
    # correct 32s ladder at 27%.
    meta = parse_probe_metadata({
        "streams": [{"width": 640, "height": 480, "r_frame_rate": "25/1",
                     "tags": {"language": "eng",
                              "DURATION-eng": "00:02:00.000000000",
                              "DURATION": "00:00:32.200000000"}}],
        # The container's duration is stale as well, as it is on a cut that
        # could not rewrite its header. With a fresh one here the cap at
        # `format.duration` would trim the stale tag to 32.2 on its own, and
        # this test would pass whichever key were read.
        "format": {"duration": "120.008000", "format_name": _MKV},
    })
    assert meta.video_duration_seconds == pytest.approx(32.2)


def test_a_suffixed_tag_on_its_own_is_not_read_at_all():
    # And with no fresh tag beside it there is nothing to fall back to. Reading
    # it anyway would be judging on a number from another file; declining leaves
    # the file unjudged, which is the safe half of the asymmetry.
    meta = parse_probe_metadata({
        "streams": [{"width": 640, "height": 480, "r_frame_rate": "25/1",
                     "tags": {"language": "eng",
                              "DURATION-eng": "00:02:00.000000000"}}],
        "format": {"duration": "32.200000", "format_name": _MKV},
    })
    assert meta.video_duration_seconds is None


def test_a_lowercase_duration_key_is_not_the_tag():
    # Matroska tag names are case-sensitive and every muxer measured writes
    # `DURATION`; ffmpeg 7.1.5 writes it that way even for a track carrying a
    # language. A lowercase key is therefore something else, and guessing that
    # it means the same thing is guessing.
    meta = parse_probe_metadata({
        "streams": [{"width": 640, "height": 480, "r_frame_rate": "25/1",
                     "tags": {"duration": "00:01:00.000000000"}}],
        "format": {"duration": "90.000000", "format_name": _MKV},
    })
    assert meta.video_duration_seconds is None


def test_a_tag_longer_than_the_container_is_capped_at_the_container():
    # A Matroska cut out of a longer one and written to a pipe keeps the
    # source's Segment Duration, because the muxer cannot seek back to correct
    # it. Where the tag outruns the container, the tag is not about this file's
    # packets, and the smaller number is the safe one: capping can only make the
    # check more permissive, never more eager.
    meta = parse_probe_metadata({
        "streams": [{"width": 640, "height": 480, "r_frame_rate": "25/1",
                     "tags": {"DURATION": "00:02:00.000000000"}}],
        "format": {"duration": "32.000000", "format_name": _MKV},
    })
    assert meta.video_duration_seconds == pytest.approx(32.0)


def test_no_video_duration_anywhere_is_none_rather_than_the_container():
    # A Matroska written to a pipe, which carries neither field nor tag: a live
    # recorder, a browser capture. The container's number is still the wrong one
    # for this purpose, so nothing is offered and the check stays inert.
    meta = parse_probe_metadata({
        "streams": [{"width": 640, "height": 480, "r_frame_rate": "25/1"}],
        "format": {"duration": "90.000000", "format_name": _MKV},
    })
    assert meta.duration_seconds == pytest.approx(90.0)
    assert meta.video_duration_seconds is None


def test_a_missing_format_name_declines_rather_than_assuming_mp4():
    # ffprobe always reports one, so this is about what happens when the shape
    # of the probe changes underneath: an absent family must not default into
    # the one family that is trusted.
    meta = parse_probe_metadata({
        "streams": [{"duration": "600.000000", "width": 1920, "height": 1080,
                     "r_frame_rate": "25/1"}],
        "format": {"duration": "600.000000"},
    })
    assert meta.duration_seconds == pytest.approx(600.0)
    assert meta.video_duration_seconds is None


@pytest.mark.parametrize("name", ["mov", "mp4", _MOV])
def test_each_name_in_the_mov_family_counts_on_its_own(name):
    # ffprobe emits the whole comma-joined family, so in practice the set is only
    # ever pinned as "intersects that list" and dropping one member changes
    # nothing. This pins the intent instead: each name means the mov/mp4 demuxer,
    # and a probe reporting just one of them is not a different container.
    meta = parse_probe_metadata({
        "streams": [{"duration": "600.000000", "width": 1920, "height": 1080,
                     "r_frame_rate": "25/1"}],
        "format": {"duration": "600.000000", "format_name": name},
    })
    assert meta.video_duration_seconds == pytest.approx(600.0)


@pytest.mark.parametrize("fmt", [{}, {"format_name": "avi"},
                                 {"format_name": "asf"}])
def test_the_duration_tag_is_only_read_for_matroska(fmt):
    # The other half of "an absent family must not default into a trusted one":
    # it must not fall into the *tag* rule either. No accepted container besides
    # Matroska publishes stream tags at all on ffmpeg 7.1.5 -- AVI, MPEG-PS and
    # ASF publish none -- so this guards against a shape some other muxer writes,
    # and it is the gate Ravi asked for by name.
    probe = {
        "streams": [{"width": 640, "height": 480, "r_frame_rate": "25/1",
                     "tags": {"DURATION": "00:02:00.000000000"}}],
        "format": {"duration": "120.000000", **fmt},
    }
    assert parse_probe_metadata(probe).video_duration_seconds is None


def test_a_duration_tag_with_no_container_duration_is_used_as_it_stands():
    # The cap's other branch: nothing to cap against. A Matroska written without
    # a segment duration still states its track's extent, and capping at a
    # missing number -- treating it as zero -- would switch the check off there.
    meta = parse_probe_metadata({
        "streams": [{"width": 640, "height": 480, "r_frame_rate": "25/1",
                     "tags": {"DURATION": "00:00:30.000000000"}}],
        "format": {"format_name": _MKV},
    })
    assert meta.video_duration_seconds == pytest.approx(30.0)


def test_a_negative_start_time_does_not_inflate_the_tag():
    # A Matroska can report a start before zero -- the corpus has one at
    # -0.007s and a PTS-wrapped file at -3.7s. Subtracting a negative number
    # *adds* to the tag's end timestamp, which refuses an intact file, so the
    # offset is floored at zero.
    meta = parse_probe_metadata({
        "streams": [{"width": 640, "height": 480, "r_frame_rate": "25/1",
                     "start_time": "-3.717689",
                     "tags": {"DURATION": "00:00:30.000000000"}}],
        "format": {"duration": "30.000000", "format_name": _MKV},
    })
    assert meta.video_duration_seconds == pytest.approx(30.0)


@pytest.mark.parametrize("tag, why", [
    ("N/A", "ffprobe's own placeholder"),
    ("00:00", "minutes and seconds only, no hours field"),
    ("00:00:00.000000000", "a zero extent says nothing"),
    ("00:31:18,123", "comma decimal separator"),
])
def test_an_unusable_duration_tag_is_ignored(tag, why):
    meta = parse_probe_metadata({
        "streams": [{"width": 640, "height": 480, "r_frame_rate": "25/1",
                     "tags": {"DURATION": tag}}],
        "format": {"duration": "90.000000", "format_name": _MKV},
    })
    assert meta.video_duration_seconds is None, why


def test_a_tag_shorter_than_the_offset_is_ignored_rather_than_negative():
    meta = parse_probe_metadata({
        "streams": [{"width": 640, "height": 480, "r_frame_rate": "25/1",
                     "start_time": "50.0",
                     "tags": {"DURATION": "00:00:30.000000000"}}],
        "format": {"duration": "90.000000", "format_name": _MKV},
    })
    assert meta.video_duration_seconds is None


def test_an_unreadable_start_time_is_treated_as_zero():
    meta = parse_probe_metadata({
        "streams": [{"width": 640, "height": 480, "r_frame_rate": "25/1",
                     "start_time": "N/A",
                     "tags": {"DURATION": "00:00:30.000000000"}}],
        "format": {"duration": "90.000000", "format_name": _MKV},
    })
    assert meta.video_duration_seconds == pytest.approx(30.0)


def test_a_missing_stream_duration_in_an_mp4_declines():
    # Honest about what this covers: the absent field, which reaches
    # `video_track_seconds` as None and declines there. A field holding "N/A"
    # does not reach it -- `duration_seconds` parses the same field two lines
    # earlier and raises, exactly as it does on main -- so the ValueError half of
    # that guard is unreachable today and is kept only because the two failure
    # modes belong together.
    meta = parse_probe_metadata({
        "streams": [{"width": 640, "height": 480, "r_frame_rate": "25/1"}],
        "format": {"duration": "90.000000", "format_name": _MOV},
    })
    assert meta.duration_seconds == pytest.approx(90.0)
    assert meta.video_duration_seconds is None


def test_a_matroska_stream_duration_is_ignored_in_favour_of_the_tag():
    # The two rules do not overlap: Matroska publishes no per-stream duration,
    # so a value appearing there came from somewhere unexpected and the tag,
    # which is what ffmpeg actually writes, is what counts.
    meta = parse_probe_metadata({
        "streams": [{"duration": "600.000000", "width": 1920, "height": 1080,
                     "r_frame_rate": "25/1",
                     "tags": {"DURATION": "00:00:20.000000000"}}],
        "format": {"duration": "600.000000", "format_name": _MKV},
    })
    assert meta.video_duration_seconds == pytest.approx(20.0)


@pytest.mark.parametrize("tag", ["00:00:inf", "inf:00:00", "00:00:nan"])
def test_a_non_finite_duration_tag_is_ignored(tag):
    # `inf` passes a `> 0` test and then refuses every ladder at 0% while the
    # file is perfectly good -- the same trap `hls_output_seconds` already guards
    # on `#EXTINF`, one function further down the same comparison.
    meta = parse_probe_metadata({
        "streams": [{"width": 640, "height": 480, "r_frame_rate": "25/1",
                     "tags": {"DURATION": tag}}],
        "format": {"duration": "90.000000", "format_name": _MKV},
    })
    assert meta.video_duration_seconds is None


def test_a_non_finite_container_duration_does_not_become_the_cap():
    # Documentation of the contract rather than cover: `min(tag, inf)` is the tag
    # either way, so dropping `isfinite` from `_format_end_seconds` cannot be
    # observed here and that mutation is equivalent. The guard stays because the
    # function's answer is meant to be a real duration, not because a test
    # catches its absence.
    meta = parse_probe_metadata({
        "streams": [{"width": 640, "height": 480, "r_frame_rate": "25/1",
                     "tags": {"DURATION": "00:00:30.000000000"}}],
        "format": {"duration": "inf", "format_name": _MKV},
    })
    assert meta.video_duration_seconds == pytest.approx(30.0)


def test_a_zero_disposition_written_as_a_string_is_still_zero():
    # ffprobe writes the flag as an integer. Were it ever a string, treating
    # every value as true would make every file decline -- the check switched off
    # everywhere, which looks exactly like nothing happening.
    meta = parse_probe_metadata({
        "streams": [{"duration": "600.000000", "width": 1920, "height": 1080,
                     "r_frame_rate": "25/1",
                     "disposition": {"attached_pic": "0"}}],
        "format": {"duration": "600.000000", "format_name": _MOV},
    })
    assert meta.video_duration_seconds == pytest.approx(600.0)

    cover = parse_probe_metadata({
        "streams": [{"duration": "600.000000", "width": 600, "height": 600,
                     "r_frame_rate": "90000/1",
                     "disposition": {"attached_pic": "1"}}],
        "format": {"duration": "600.000000", "format_name": _MOV},
    })
    assert cover.video_duration_seconds is None


@pytest.mark.parametrize("field", ["disposition", "tags"])
def test_a_probe_whose_shape_moved_declines_rather_than_raising(field):
    # `parse_probe_metadata` is also called by `get_video_metadata`, where an
    # AttributeError would propagate. On main these inputs could not raise, and
    # a new field must not make them able to.
    # A non-empty list: an empty one is falsy, so `value or {}` would still
    # yield a mapping and the guard would look held when it is not.
    stream = {"width": 640, "height": 480, "r_frame_rate": "25/1",
              field: [{"DURATION": "00:02:00.000000000"}]}
    meta = parse_probe_metadata({
        "streams": [stream],
        "format": {"duration": "90.000000", "format_name": _MKV},
    })
    assert meta.duration_seconds == pytest.approx(90.0)
    assert meta.video_duration_seconds is None


def test_a_format_block_that_is_not_a_mapping_declines():
    meta = parse_probe_metadata({
        "streams": [{"duration": "600.000000", "width": 640, "height": 480,
                     "r_frame_rate": "25/1"}],
        "format": [{"duration": "600.000000"}],
    })
    assert meta.duration_seconds == pytest.approx(600.0)
    assert meta.video_duration_seconds is None


def test_the_file_duration_is_unchanged_by_all_of_this():
    # `duration_seconds` is what reaches the database, the player and the
    # comment timecodes, and it must keep behaving exactly as it does on main:
    # the stream's own figure where there is one, the format's otherwise --
    # whatever the container, and whether or not the video track is judged.
    for format_name in ("asf", "avi", "mpeg", _MOV, _MKV, None):
        fmt = {"duration": "40.000000"}
        if format_name:
            fmt["format_name"] = format_name
        with_stream = parse_probe_metadata({
            "streams": [{"duration": "30.000000", "width": 640, "height": 480,
                         "r_frame_rate": "25/1"}],
            "format": fmt,
        })
        assert with_stream.duration_seconds == pytest.approx(30.0), format_name
        without = parse_probe_metadata({
            "streams": [{"width": 640, "height": 480, "r_frame_rate": "25/1"}],
            "format": fmt,
        })
        assert without.duration_seconds == pytest.approx(40.0), format_name


# ------------------------------------------------------- reading the playlist

def test_the_length_comes_from_the_playlist_not_the_segment_count(tmp_path):
    # Segment length varies with the frame rate, and on the copy path it comes
    # from the source's GOP rather than -hls_time, so counting files and
    # multiplying would be wrong on exactly the path this bug was found on.
    _variant(tmp_path, "0", [2.9029, 1.935267, 1.935267, 0.433767])
    assert hls_output_seconds(tmp_path) == pytest.approx(7.207201)


def test_the_longest_variant_wins(tmp_path):
    # A ladder writes one playlist per rung. They should agree; if they do not,
    # the longest is the one that says how much of the source was read.
    #
    # The long one is deliberately *not* the first the glob returns: with the
    # longest also sorting first, an implementation that simply kept the first
    # playlist it read would pass this and lose a truncated rung.
    _variant(tmp_path, "0", [2.0, 2.0])
    _variant(tmp_path, "1", [2.0, 2.0, 2.0])
    assert hls_output_seconds(tmp_path) == pytest.approx(6.0)


def test_the_longest_variant_wins_in_either_order(tmp_path):
    # And the mirror, so neither "first" nor "last" passes by accident.
    _variant(tmp_path, "0", [2.0, 2.0, 2.0])
    _variant(tmp_path, "1", [2.0, 2.0])
    assert hls_output_seconds(tmp_path) == pytest.approx(6.0)


def test_a_directory_with_no_playlist_reads_as_none(tmp_path):
    assert hls_output_seconds(tmp_path) is None


def test_a_malformed_line_does_not_lose_the_rest(tmp_path):
    d = tmp_path / "0"
    d.mkdir()
    (d / "playlist.m3u8").write_text(
        "#EXTM3U\n#EXTINF:2.000000,\nseg_000.ts\n"
        "#EXTINF:not-a-number,\nseg_001.ts\n"
        "#EXTINF:2.000000,\nseg_002.ts\n#EXT-X-ENDLIST\n"
    )
    # Better to under-report by one segment than to raise here: the caller is
    # deciding whether to keep a transcode, and an exception would fail it for
    # the wrong reason.
    assert hls_output_seconds(d.parent) == pytest.approx(4.0)


@pytest.mark.parametrize("value", ["nan", "inf", "-inf"])
def test_a_non_finite_segment_length_is_not_summed(tmp_path, value):
    # `nan` loses every comparison, so one of them would make the check accept
    # any ladder at all; `inf` swamps the sum to the same effect. Neither has
    # been seen out of ffmpeg -- this is a floor under the arithmetic, not a
    # reported failure.
    d = tmp_path / "0"
    d.mkdir()
    (d / "playlist.m3u8").write_text(
        f"#EXTM3U\n#EXTINF:2.000000,\nseg_000.ts\n"
        f"#EXTINF:{value},\nseg_001.ts\n#EXT-X-ENDLIST\n"
    )
    assert hls_output_seconds(d.parent) == pytest.approx(2.0)


def test_a_playlist_that_cannot_be_read_does_not_escape(tmp_path):
    # A path matching the glob that is not a readable file -- here a directory
    # of that name. An OSError out of here would bypass the attempt loop's
    # RuntimeError handler and burn the hardware and remux fallbacks on a
    # filesystem hiccup.
    (tmp_path / "0" / "playlist.m3u8").mkdir(parents=True)
    _variant(tmp_path, "1", [2.0, 2.0])
    assert hls_output_seconds(tmp_path) == pytest.approx(4.0)


# --------------------------------------------------------------- the refusal

def test_a_full_length_ladder_is_accepted(tmp_path):
    _variant(tmp_path, "0", [2.0] * 50)
    refuse_a_truncated_result(tmp_path, 100.0)


def test_the_live_case_is_refused(tmp_path):
    # The numbers that were actually stored: 97.2s of a 1877.7s master.
    _variant(tmp_path, "0", [1.935267] * 50 + [0.433767])
    assert hls_output_seconds(tmp_path) == pytest.approx(97.2, abs=0.05)
    with pytest.raises(TranscodeTruncated) as exc:
        refuse_a_truncated_result(tmp_path, 1877.709167, label="ffmpeg (copy)")
    message = str(exc.value)
    assert "5%" in message
    assert "1877.7s video track" in message
    assert "ffmpeg (copy)" in message


def test_a_ladder_longer_than_its_source_is_accepted(tmp_path):
    # The check is one-sided on purpose. A copied ladder ends where the GOP
    # ends and an encoded one pads to the next frame, so output past the
    # source's last timestamp is ordinary -- measured at +0.040s on the encode
    # path, and larger when a late-starting picture is padded from zero.
    # Making the tolerance symmetric would refuse those.
    _variant(tmp_path, "0", [2.0] * 60)
    refuse_a_truncated_result(tmp_path, 100.0)


def test_an_intact_source_whose_audio_outlives_its_video_is_accepted(tmp_path):
    # A 20s picture in a 35s file. This is the function's half of the story;
    # `test_a_matroska_with_an_audio_tail_is_not_refused_end_to_end` is the
    # half that holds the call site to handing over the right number.
    _variant(tmp_path, "0", [2.0] * 10 + [0.023])
    refuse_a_truncated_result(tmp_path, 20.023)


def test_a_last_segment_cut_short_is_not_a_truncation(tmp_path):
    # The muxer ends the last segment where the frames end, so an exact match
    # is not on offer. Measured drift on a complete ladder: +0.023s on the copy
    # path, -0.040s on the encode path, at 1, 10 and 40 minutes alike.
    _variant(tmp_path, "0", [2.0] * 49 + [1.5])
    refuse_a_truncated_result(tmp_path, 100.0)


def test_the_slack_is_three_seconds_and_is_pinned_from_both_sides(tmp_path):
    # A slack is only as good as its upper bound: raising the floor is
    # invisible to a test that only checks that rounding is tolerated. These
    # bracket it to (2.9s, 3.1s], which is tight enough that the measured drift
    # of 0.04s and the claim that 3s is 75 times it both stay honest.
    knapp, drueber = tmp_path / "knapp", tmp_path / "drueber"
    _variant(knapp, "0", [2.0] * 48 + [1.1])       # 97.1s of 100s, inside
    refuse_a_truncated_result(knapp, 100.0)

    _variant(drueber, "0", [2.0] * 48 + [0.9])     # 96.9s of 100s, outside
    with pytest.raises(TranscodeTruncated):
        refuse_a_truncated_result(drueber, 100.0)


def test_exactly_the_slack_short_is_still_accepted(tmp_path):
    # The boundary itself, so `<` cannot quietly become `<=`. 97.0s of a 100s
    # source is exactly three seconds short and is rounding, not truncation.
    _variant(tmp_path, "0", [2.0] * 48 + [1.0])
    refuse_a_truncated_result(tmp_path, 100.0)


def test_the_slack_does_not_grow_with_the_source(tmp_path):
    # The same shortfall on a 40-minute master. A proportional term would
    # forgive up to 24s here and let a quarter-minute of missing video through
    # on a long file while catching it on a short one.
    _variant(tmp_path, "0", [2.0] * 1198 + [0.9])   # 2396.9s of 2400s
    with pytest.raises(TranscodeTruncated):
        refuse_a_truncated_result(tmp_path, 2400.0)


def test_no_playlist_at_all_is_deliberately_not_judged(tmp_path):
    # ffmpeg with an HLS muxer either writes a playlist or exits non-zero, so
    # an empty directory here means the output layout moved rather than that a
    # transcode was cut short -- and failing every asset over a renamed
    # directory is the worse error. The wiring tests below are what keep this
    # from being a quiet way for the whole check to stop applying.
    refuse_a_truncated_result(tmp_path, 100.0)


def test_an_unknown_source_duration_cannot_be_judged(tmp_path):
    # Refusing here would turn a missing number into a failed asset -- and,
    # through the reaper, into a deleted master.
    #
    # Honest about what this holds: `None` is pinned, because dropping the
    # guard makes the comparison raise TypeError. `0.0` takes the same branch
    # and cannot fail on its own, since no comparison against zero raises; it
    # is asserted as documentation of the contract, not as cover.
    _variant(tmp_path, "0", [2.0])
    refuse_a_truncated_result(tmp_path, None)
    refuse_a_truncated_result(tmp_path, 0.0)


# ------------------------------------------------------------- the wiring
#
# What has to stay true in the transcode itself, none of it visible to a test
# of the function alone:
#
#   * the check runs on the branch production actually takes -- with a
#     progress callback, which `process_asset` always passes, and which goes
#     through Popen rather than subprocess.run,
#   * it runs on the copy path, which is the path the incident happened on,
#   * it runs on a later attempt, not only the first,
#   * it is handed the video track's length and never the container's,
#   * nothing is uploaded when it refuses, and
#   * a refusal is not absorbed by the fallback to the encoder.
#
# Each has its own test, because each can be broken without the others
# noticing -- and several of these exist because they were broken and nothing
# noticed.


def _drive_a_transcode(
    tmp_path, written_seconds, source_seconds=600.0, *,
    copy_path=False, with_progress=True, video_stream=None, audio_stream=None,
    format_duration=None, format_name=_MOV, first_attempt_fails=False,
    first_attempt_writes_first=False, final_attempt=False,
):
    """Run the real transcode with a mocked ffmpeg that writes a real playlist.

    The mock does what ffmpeg does rather than only reporting that it did: it
    reads the output path out of the command it was handed and writes a
    playlist there. Without that, nothing here would notice the check being
    removed from the transcode.

    Both process launchers are mocked. `process_asset` always passes a
    `progress_cb`, and that branch runs ffmpeg through `Popen`, so a driver
    that only patched `subprocess.run` would cover the branch production never
    takes -- which is how the check came to be testable and untested at once.

    Returns `(result, s3, commands)`.
    """
    import asyncio
    import subprocess
    from pathlib import Path
    from unittest.mock import MagicMock, patch

    from packages.transcoder.base import TranscodeJob
    from packages.transcoder.ffmpeg_transcoder import FFmpegTranscoder

    stream = video_stream if video_stream is not None else {
        "codec_name": "h264", "pix_fmt": "yuv420p", "r_frame_rate": "25/1",
        "duration": f"{source_seconds:.6f}", "width": 1920, "height": 1080,
        "start_time": "0.000000",
    }
    fmt = {
        "duration": f"{format_duration if format_duration is not None else source_seconds:.6f}",
        "format_name": format_name,
    }
    audio = [audio_stream] if audio_stream else []
    commands: list[list[str]] = []
    attempts = {"hls": 0}

    def _write_playlist(cmd, seconds):
        target = Path(cmd[-1])                          # <work>/hls/%v/playlist.m3u8
        variant = Path(str(target.parent).replace("%v", "0"))
        variant.mkdir(parents=True, exist_ok=True)
        whole, rest = divmod(seconds, 2.0)
        lines = ["#EXTM3U", "#EXT-X-VERSION:6", "#EXT-X-PLAYLIST-TYPE:VOD"]
        for i in range(int(whole)):
            lines += ["#EXTINF:2.000000,", f"seg_{i:03d}.ts"]
        if rest:
            lines += [f"#EXTINF:{rest:.6f},", f"seg_{int(whole):03d}.ts"]
        lines.append("#EXT-X-ENDLIST")                  # as ffmpeg leaves it
        (variant / "playlist.m3u8").write_text("\n".join(lines) + "\n")
        (variant / "seg_000.ts").write_bytes(b"\x47" * 188)

    def _hls_seconds(cmd):
        """How long the ladder this invocation writes comes out.

        `written_seconds` may be a per-attempt list, so a run can fail its
        first backend at runtime and produce a short ladder on the fallback.
        """
        index = attempts["hls"]
        attempts["hls"] += 1
        if isinstance(written_seconds, (list, tuple)):
            return written_seconds[min(index, len(written_seconds) - 1)]
        return written_seconds

    def _answer(cmd):
        """What a run of `cmd` produces, as (returncode, stdout, stderr)."""
        commands.append(cmd)
        if cmd[0] == "ffprobe":
            selected = (cmd[cmd.index("-select_streams") + 1]
                        if "-select_streams" in cmd else "")
            if selected != _PRIMARY_VIDEO_STREAM:
                return 0, json.dumps({"streams": audio}), ""
            if "packet=pts_time,flags" in cmd:
                # The copy path's keyframe probe: a closed GOP every two
                # seconds, which is what makes a remux allowed at all.
                #
                # It answers per window. The transcoder probes the head and the
                # tail, and a mock that always replies with head keyframes
                # makes the tail window look like one enormous gap -- the copy
                # is then refused, the run quietly becomes an encode, and a
                # test that believes it covers the copy path covers nothing.
                interval = cmd[cmd.index("-read_intervals") + 1]
                start_text, _, length_text = interval.partition("%+")
                start = float(start_text) if start_text else 0.0
                length = float(length_text)
                return 0, json.dumps({"packets": [
                    {"pts_time": f"{start + t:.3f}", "flags": "K_"}
                    for t in range(0, int(length) + 1, 2)
                ]}), ""
            return 0, json.dumps({"streams": [stream], "format": fmt}), ""
        if cmd[0] == "ffmpeg" and "trace_headers" in cmd:
            # Every sync sample an IDR, no recovery points: copyable. The count
            # has to match the keyframes reported for the same window, or the
            # transcoder refuses the copy and the run becomes an encode.
            length = float(cmd[cmd.index("-t") + 1])
            return 0, "", "\n".join(
                "[trace_headers @ 0x1] nal_unit_type: 5(IDR)"
                for _ in range(0, int(length) + 1, 2)
            )
        if "-f" in cmd and cmd[cmd.index("-f") + 1] == "hls":
            if first_attempt_fails and attempts["hls"] == 0:
                # A remux that fails on its own terms, which is what the
                # fallback to the encoder exists for (#372). It may have written
                # part of a ladder before dying, which is what ffmpeg does.
                if first_attempt_writes_first:
                    _write_playlist(cmd, _hls_seconds(cmd))
                else:
                    attempts["hls"] += 1
                return 1, "", "Invalid data found when processing input"
            _write_playlist(cmd, _hls_seconds(cmd))
        return 0, "", ""

    def run(cmd, **_kwargs):
        rc, out, err = _answer(cmd)
        mock = MagicMock()
        mock.returncode, mock.stdout, mock.stderr = rc, out, err
        if rc != 0 and _kwargs.get("check"):
            raise subprocess.CalledProcessError(rc, cmd, out, err)
        return mock

    def popen(cmd, stdout=None, stderr=None, **_kwargs):
        # `_run_with_progress` inserts `-progress pipe:1 -nostats` after argv[0]
        # and then reads argv[-1] as the output path, exactly as here.
        rc, _out, err = _answer([cmd[0], *cmd[3:]])
        if stderr is not None:
            stderr.write(err)
        read_fd, write_fd = os.pipe()
        os.close(write_fd)                       # immediate EOF: no progress lines
        proc = MagicMock()
        proc.stdout.fileno.return_value = read_fd
        proc.poll.return_value = rc
        proc.wait.return_value = rc
        proc.returncode = rc
        proc.stdout.close.side_effect = lambda: os.close(read_fd)
        return proc

    s3 = MagicMock()
    s3.generate_presigned_url.return_value = "https://s3.example.com/in.mp4"
    job = TranscodeJob(
        media_id="m1", version_id="v1", input_s3_key="raw/in.mp4",
        output_s3_prefix="processed/m1/v1", qualities=["1080p"],
        progress_cb=(lambda _percent: None) if with_progress else None,
        final_attempt=final_attempt,
    )
    env = {}
    if copy_path:
        env["TRANSCODER_SOURCE_COPY"] = "1"
    with patch.dict(os.environ, env, clear=False), \
            patch("subprocess.run", side_effect=run), \
            patch("subprocess.Popen", side_effect=popen):
        result = asyncio.run(FFmpegTranscoder(s3, "bucket").transcode(job))
    return result, s3, commands


def _hls_commands(commands):
    return [c for c in commands if "-f" in c and c[c.index("-f") + 1] == "hls"]


@pytest.mark.parametrize("with_progress", [True, False])
def test_the_check_is_wired_into_the_encode_path(tmp_path, with_progress):
    # `process_asset` passes a progress callback on every video job, and that
    # branch runs ffmpeg through Popen. Parametrised so the check cannot be
    # moved into the branch nobody runs while the suite stays green.
    #
    # The assertion is on the result rather than on a raised exception because
    # `transcode` turns every exception into `TranscodeResult(success=False)`.
    # That is the contract the task reads: `not result.success` makes it raise,
    # and the task retries three times a minute apart, which for a read that
    # ended early is exactly the right remedy.
    result, _, _ = _drive_a_transcode(
        tmp_path, written_seconds=98.0, source_seconds=600.0,
        with_progress=with_progress,
    )
    assert result.success is False
    assert "16%" in result.error
    assert "600.0s video track" in result.error


@pytest.mark.parametrize("with_progress", [True, False])
def test_the_check_is_wired_into_the_copy_path(tmp_path, with_progress):
    # The path the incident actually happened on, and the one a check can be
    # dropped from while every other test here stays green.
    result, _, commands = _drive_a_transcode(
        tmp_path, written_seconds=98.0, source_seconds=600.0, copy_path=True,
        with_progress=with_progress,
    )
    assert result.success is False
    assert "16%" in result.error
    # Not just the message: the ladder really was built by a remux. Without
    # this the run could silently have fallen back to the encoder.
    assert any(any(c[i].startswith("-c:v") and c[i + 1] == "copy"
                   for i in range(len(c) - 1))
               for c in _hls_commands(commands))
    assert "(copy)" in result.error


def test_the_check_runs_on_a_later_attempt_too(tmp_path):
    # A remux that fails on its own terms falls back to the encoder, and that
    # second ladder is checked like any other. Only pinning the first attempt
    # would leave every fallback run unguarded, which is a live path: the
    # attempt list is built to hold two or three entries, and a self-hosted
    # instance with the copy path on reaches it whenever a remux is refused.
    result, _, commands = _drive_a_transcode(
        tmp_path, written_seconds=[0.0, 98.0], source_seconds=600.0,
        copy_path=True, first_attempt_fails=True,
    )
    assert len(_hls_commands(commands)) == 2, "the fallback attempt must have run"
    assert result.success is False
    assert "16%" in result.error
    assert "(cpu)" in result.error, "the refusal came from the fallback attempt"


def test_an_attempt_that_died_after_writing_does_not_vouch_for_the_next(tmp_path):
    # The remux writes a full 600s ladder, dies anyway, and the encoder that
    # follows manages only 98s. The short one is what counts.
    #
    # What this does *not* hold: `hls_output_seconds` takes the longest variant
    # it finds, so a stale playlist left by a dead attempt would vouch for its
    # successor -- but it cannot survive to do so, because every attempt writes
    # the same playlist paths and truncates them. The copy path is only ever
    # chosen with a single rung (`len(qualities) == 1`), so its fallback encode
    # writes variant `0` exactly as the copy did. Deleting the `shutil.rmtree`
    # between attempts therefore changes nothing here, and I did not invent a
    # test to pretend otherwise. It would start to matter if attempts were ever
    # given separate output directories.
    result, _, commands = _drive_a_transcode(
        tmp_path, written_seconds=[600.0, 98.0], source_seconds=600.0,
        copy_path=True, first_attempt_fails=True, first_attempt_writes_first=True,
    )
    assert len(_hls_commands(commands)) == 2, "the fallback attempt must have run"
    assert result.success is False
    assert "16%" in result.error


def test_a_refused_transcode_uploads_nothing(tmp_path):
    # The check runs before the ladder goes to the bucket, not after. If it
    # moved below the upload the transcode would still fail -- and a short
    # ladder would still be sitting in the store under the version's prefix.
    result, s3, _ = _drive_a_transcode(
        tmp_path, written_seconds=98.0, source_seconds=600.0, copy_path=True,
    )
    assert result.success is False
    assert s3.upload_file.call_count == 0
    assert s3.put_object.call_count == 0


def test_a_refused_copy_does_not_fall_back_to_the_encoder(tmp_path):
    # A remux that fails on its own terms is worth encoding instead (#372). A
    # remux that stopped early is worth *reading again*: the source is intact,
    # so a fresh read is the remedy and the task already retries. Falling back
    # here would re-read the same input the same way and cost hours doing it.
    #
    # The encoder would produce a full-length ladder on its attempt, so without
    # `except TranscodeTruncated: raise` this transcode reports success.
    result, _, commands = _drive_a_transcode(
        tmp_path, written_seconds=[98.0, 600.0], source_seconds=600.0,
        copy_path=True,
    )
    assert result.success is False
    assert _REFUSED in result.error
    assert len(_hls_commands(commands)) == 1, "the encoder must not have run"


def test_a_full_length_transcode_passes_the_check(tmp_path):
    # The control. A ladder as long as its source must get past the check.
    # Asserting only on the absence of *this* failure keeps the test from
    # depending on what the surrounding mocks do afterwards.
    result, _, _ = _drive_a_transcode(
        tmp_path, written_seconds=600.0, source_seconds=600.0,
    )
    assert _REFUSED not in (result.error or "")
    assert result.success is True


def test_a_matroska_with_an_audio_tail_is_not_refused_end_to_end(tmp_path):
    # Blocker 1 as the transcode sees it: a 600s picture beside a 900s audio
    # track, so the container reports 900s. The ladder is complete. Handing the
    # check the container's number refuses it at 67%, and because the mismatch
    # reproduces on every read the upload ends at `failed` and its master is
    # reaped a day later.
    #
    # `format_name` matters here and is the reason this test was once green for
    # the wrong reason: without it the driver's mov/mp4 default was in force, the
    # stream carries a tag and no `duration` field, so the whole check declined
    # and the test passed on a file it never judged. It is the only end-to-end
    # test that drives the Matroska branch, so it now says so out loud.
    result, _, _ = _drive_a_transcode(
        tmp_path,
        written_seconds=600.0,
        source_seconds=600.0,
        format_name=_MKV,
        video_stream={
            "codec_name": "h264", "pix_fmt": "yuv420p", "r_frame_rate": "25/1",
            "width": 1920, "height": 1080, "start_time": "0.000000",
            "tags": {"DURATION": "00:10:00.000000000"},
        },
        audio_stream={"codec_name": "aac", "duration": "900.000000"},
        format_duration=900.0,
    )
    assert _REFUSED not in (result.error or "")
    assert result.success is True


def test_a_matroska_whose_ladder_is_short_is_refused_end_to_end(tmp_path):
    # The mirror, so the branch above is driven in both directions: the same
    # 600s tag, a ladder of 98s. Without this, making the Matroska branch return
    # None would leave every Matroska unjudged with the suite green.
    result, _, _ = _drive_a_transcode(
        tmp_path,
        written_seconds=98.0,
        source_seconds=600.0,
        format_name=_MKV,
        video_stream={
            "codec_name": "h264", "pix_fmt": "yuv420p", "r_frame_rate": "25/1",
            "width": 1920, "height": 1080, "start_time": "0.000000",
            "tags": {"DURATION": "00:10:00.000000000"},
        },
        format_duration=900.0,
    )
    assert result.success is False
    assert "600.0s video track" in result.error


def test_a_truncated_avi_is_stored_as_it_always_was(tmp_path):
    # The cost of judging narrowly, stated rather than left to be discovered.
    # AVI, MPEG-PS and WMV are three of the seven video types the product
    # accepts, and for those this check is now permanently inert: a genuinely
    # truncated one is stored `ready` with a short ladder, exactly as on main.
    #
    # That is the deliberate trade -- their per-stream duration is synthesised
    # and judging on it refuses intact uploads -- and this test exists so the
    # trade is visible in the suite instead of only in a comment.
    result, s3, _ = _drive_a_transcode(
        tmp_path, written_seconds=98.0, source_seconds=600.0,
        format_name="avi",
    )
    assert result.success is True
    assert s3.upload_file.call_count > 0


# ------------------------------------------- the last attempt gives way
#
# The half of this feature that decides what a wrong answer costs. Refusing
# forever spends the master; refusing once spends a minute.

def test_the_last_attempt_stores_a_short_ladder_rather_than_failing(tmp_path,
                                                                    capsys):
    # The same file that is refused above, on the attempt after which there is
    # no retry left. It has to come out stored: `failed` is what brings the
    # reaper, and the reaper deletes the original -- which for every shape in
    # the metadata section above is an intact upload.
    result, _, _ = _drive_a_transcode(
        tmp_path, written_seconds=98.0, source_seconds=600.0,
        final_attempt=True,
    )
    assert _REFUSED not in (result.error or "")
    assert result.success is True
    # Loud, and with both numbers, because the log line is now the only trace.
    # Both numbers and the share, which is what Ravi asked the line to carry.
    # Asserted as the three facts rather than as a sentence, so the wording can
    # be improved without a red test.
    logged = capsys.readouterr().out
    assert "98.0s" in logged and "600.0s" in logged and "16%" in logged


def test_the_last_attempt_still_uploads_what_it_kept(tmp_path):
    # Accepting means accepting: the ladder reaches the bucket and the version
    # becomes `ready`, rather than being dropped on the floor between the two
    # behaviours.
    result, s3, _ = _drive_a_transcode(
        tmp_path, written_seconds=98.0, source_seconds=600.0,
        final_attempt=True,
    )
    assert result.success is True
    assert s3.upload_file.call_count > 0


def test_an_earlier_attempt_refuses_so_the_source_is_read_again(tmp_path):
    # The mirror of the two above, pinned in the same run so the pair cannot
    # collapse into "always accept" or "always refuse" with the suite green.
    refused, s3, _ = _drive_a_transcode(
        tmp_path, written_seconds=98.0, source_seconds=600.0,
        final_attempt=False,
    )
    assert _REFUSED in (refused.error or ""), "refused for the right reason"
    assert s3.upload_file.call_count == 0
    accepted, _, _ = _drive_a_transcode(
        tmp_path, written_seconds=98.0, source_seconds=600.0,
        final_attempt=True,
    )
    assert refused.success is False
    assert accepted.success is True


def test_the_last_attempt_says_nothing_about_a_full_length_ladder(tmp_path,
                                                                  capsys):
    # The log line belongs to the mismatch, not to the last attempt. A line on
    # every final attempt would train whoever reads these logs to ignore it.
    _drive_a_transcode(
        tmp_path, written_seconds=600.0, source_seconds=600.0,
        final_attempt=True,
    )
    assert "600.0s" not in capsys.readouterr().out


def test_a_failing_log_does_not_undo_the_acceptance(tmp_path):
    # This branch exists so a mismatch cannot cost the master, so the branch must
    # not be able to cost it either. A raising stdout -- a closed pipe, a manual
    # run outside Celery's redirection -- would otherwise leave through both
    # handlers in the attempt loop and fail the transcode on precisely the
    # attempt that was added to keep it.
    from unittest.mock import patch

    _variant(tmp_path, "0", [2.0] * 49)
    with patch("builtins.print", side_effect=BrokenPipeError("closed")):
        refuse_a_truncated_result(tmp_path, 600.0, final_attempt=True)


def test_the_default_is_to_refuse(tmp_path):
    # A caller that does not say -- another backend, a script, a test -- gets
    # the refusing behaviour, so forgetting to pass the flag cannot silently
    # switch the whole check off.
    from packages.transcoder.base import TranscodeJob

    assert TranscodeJob(
        media_id="m", version_id="v", input_s3_key="k", output_s3_prefix="p",
    ).final_attempt is False

    _variant(tmp_path, "0", [2.0] * 49)
    with pytest.raises(TranscodeTruncated):
        refuse_a_truncated_result(tmp_path, 600.0)

    # And the same at the task's own seam, where the only caller always passes
    # it: a default of True there would switch the check off for anything that
    # calls `_process_video` without saying.
    import inspect

    from apps.api.tasks import transcode_tasks

    assert inspect.signature(
        transcode_tasks._process_video
    ).parameters["final_attempt"].default is False


def test_the_task_passes_its_own_retry_count_down():
    # Celery's retry state lives on the task and is read after the transcode has
    # returned (`self.request.retries >= self.max_retries`), so the transcoder
    # cannot ask for it and has to be told beforehand.
    #
    # Driven through the real task with a pushed request, and reading the flag
    # off the job the real `_process_video` built -- not off a stand-in for
    # either. That span is the point: an earlier version of this test patched
    # `_process_video` out and stopped one call short of the job, while the
    # wiring tests above construct their own job and start one step past it.
    # Deleting `final_attempt=final_attempt` from the `TranscodeJob(...)` call
    # then left every one of them green while restoring the whole defect.
    from types import SimpleNamespace
    from unittest.mock import MagicMock, patch

    from apps.api.models.asset import AssetType
    from apps.api.tasks import transcode_tasks
    from packages.transcoder.base import TranscodeResult

    # Derived from the task rather than from the literal 3, so raising the retry
    # budget is a tuning change and not a red test.
    ceiling = transcode_tasks.process_asset.max_retries

    def _flag_after(retries: int) -> bool:
        # One stand-in answers the version, asset and media-file lookups alike,
        # so it carries what all three are read for.
        row = SimpleNamespace(id="asset-1", project_id="proj-1",
                              asset_type=AssetType.video,
                              s3_key_raw="raw/in.mp4", s3_key_processed=None,
                              s3_key_download=None, s3_key_thumbnail=None,
                              processing_status=None, duration_seconds=None,
                              width=None, height=None, fps=None)
        db = MagicMock()
        db.query.return_value.filter.return_value.first.return_value = row
        result = TranscodeResult(success=True, hls_prefix="processed/x",
                                 duration_seconds=6.0, width=16, height=16,
                                 fps=25.0)
        with patch("packages.transcoder.ffmpeg_transcoder.FFmpegTranscoder") as cls, \
                patch.object(transcode_tasks, "_run_async",
                             MagicMock(return_value=result)), \
                patch.object(transcode_tasks, "SessionLocal", return_value=db), \
                patch.object(transcode_tasks, "get_s3_client", MagicMock()), \
                patch.object(transcode_tasks, "_publish_event", MagicMock()):
            cls.return_value.transcode.return_value = None
            transcode_tasks.process_asset.push_request(retries=retries)
            try:
                transcode_tasks.process_asset.run(
                    "0f9ad1d6-0000-4000-8000-000000000001",
                    "0f9ad1d6-0000-4000-8000-000000000002",
                )
            finally:
                transcode_tasks.process_asset.pop_request()
        return cls.return_value.transcode.call_args[0][0].final_attempt

    for retries, expected in ((0, False), (ceiling - 1, False),
                              (ceiling, True), (ceiling + 1, True)):
        assert _flag_after(retries) is expected, f"retries={retries}"
