"""`video_track_seconds` against ffprobe output from real files.

Every fixture in `test_transcode_refuses_a_short_result.py` is a probe result
written by hand. These are not: each one is what ffprobe actually said about a
file built for the purpose -- Debian's ffmpeg 7.1.5, whose encoder stamps itself
`Lavc61.19.101` -- reduced to the fields the function reads and
otherwise verbatim. The corpus is derived from `ALLOWED_MIME_TYPES` rather than
from what was convenient to break -- every container here is one the product
accepts.

The assertion is the one that matters, and it is the same for all of them:

    either no judgement is offered, or the number offered is within the
    tolerance of the picture's real length.

Both halves have teeth. Answering with a number that is too large refuses an
intact upload on every read but the last, which costs three full encodes before
the final attempt stores it. Answering None costs the check on that container, and
the set of containers that are judged is asserted below so that a change which
quietly switches everything off is a red test rather than a silent retreat.
"""
import pytest

from packages.transcoder.ffmpeg_transcoder import (
    _TRUNCATION_SLACK_SECONDS,
    video_track_seconds,
)

# (filename, the picture's real length, whether it was deliberately truncated,
#  the probe as measured)
MEASURED = [
    ('mp4-heil.mp4', 120.0, False, {'streams': [{'duration': '120.000000', 'start_time': '0.000000', 'tags': {'language': 'und'}}], 'format': {'duration': '120.000000', 'format_name': 'mov,mp4,m4a,3gp,3g2,mj2'}}),
  # cut on a packet boundary: the track duration still stands for the whole file, which is exactly the case the check exists to catch
    ('mp4-gekappt-bildgrenze.mp4', 34.2, True, {'streams': [{'duration': '120.000000', 'start_time': '0.000000', 'tags': {'language': 'und'}}], 'format': {'duration': '120.000000', 'format_name': 'mov,mp4,m4a,3gp,3g2,mj2'}}),
  # cut inside a packet -- through the encode pipeline exactly as silent as a clean boundary
    ('mp4-gekappt-mitten-im-paket.mp4', 34.0, True, {'streams': [{'duration': '120.000000', 'start_time': '0.000000', 'tags': {'language': 'und'}}], 'format': {'duration': '120.000000', 'format_name': 'mov,mp4,m4a,3gp,3g2,mj2'}}),
  # ASF copies the file's play duration onto every stream, so 30s of picture reports 40s
    ('wmv-ton-laeuft-nach.wmv', 30.0, False, {'streams': [{'duration': '39.999000', 'start_time': '0.046000'}], 'format': {'duration': '40.045000', 'format_name': 'asf'}}),
  # cut out of a longer mkv into a pipe: the muxer cannot seek back to correct the Segment Duration
    ('mkv-aus-pipe-geschnitten.mkv', 32.0, False, {'streams': [{'start_time': '0.059000'}], 'format': {'duration': '120.008000', 'format_name': 'matroska,webm'}}),
  # MediaRecorder plus fix-webm-duration: the Segment Duration is wall-clock, the content is shorter
    ('webm-recorder-nachgebessert.webm', 6.0, False, {'streams': [{'start_time': '0.000000', 'tags': {'DURATION': '00:00:06.000000000'}}], 'format': {'duration': '12.000000', 'format_name': 'matroska,webm'}}),
  # a canvas that goes static, so the header runs past the last packet
    ('webm-nur-bild-standbild.webm', 5.0, False, {'streams': [{'start_time': '0.000000', 'tags': {'DURATION': '00:00:05.000000000'}}], 'format': {'duration': '15.000000', 'format_name': 'matroska,webm'}}),
  # a stale DURATION-eng from an mkvmerge rip, emitted ahead of the fresh DURATION
    ('mkv-stale-duration-eng.mkv', 32.2, False, {'streams': [{'start_time': '0.007000', 'tags': {'DURATION-eng': '00:02:00.000000000', 'DURATION': '00:00:32.207000000'}}], 'format': {'duration': '32.207000', 'format_name': 'matroska,webm'}}),
  # a held last frame, stored as zero-size drop chunks that count in dwLength
    ('avi-standbild-am-ende.avi', 14.0, False, {'streams': [{'duration': '14.040000', 'start_time': '0.000000'}], 'format': {'duration': '14.040000', 'format_name': 'avi'}}),
  # written to a pipe, so the header keeps its placeholder frame count -- it reports 18985.7s for 30s of picture
    ('avi-aus-pipe.avi', 30.0, False, {'streams': [{'duration': '18985.720000', 'start_time': '0.000000'}], 'format': {'duration': '18985.720000', 'format_name': 'avi'}}),
  # MPEG-PS reports the PTS span, and a 29.5s clock jump between two spliced recordings inflates it
    ('mpg-uhrensprung.mpg', 40.0, False, {'streams': [{'duration': '69.460000', 'start_time': '0.540000'}], 'format': {'duration': '69.470911', 'format_name': 'mpeg'}}),
  # audio with cover art, probed as `v:0` (the transcoder's `V:0` would skip it): the picture gets the file's duration
    ('mp4-nur-ton-mit-titelbild.mp4', 0.0, False, {'streams': [{'duration': '30.000000', 'start_time': '0.000000', 'disposition': {'attached_pic': 1}}], 'format': {'duration': '30.000000', 'format_name': 'mov,mp4,m4a,3gp,3g2,mj2'}}),
  # the same command in Matroska, where the cover does not survive as attached_pic but as a one-frame track
    ('mkv-nur-ton-mit-titelbild.mkv', 0.0, False, {'streams': [{'start_time': '0.000000', 'tags': {'DURATION': '00:00:00.040000000'}}], 'format': {'duration': '30.008000', 'format_name': 'matroska,webm'}}),
  # Matroska's own way of carrying a cover, which is the shape a real audio file has
    ('mkv-nur-ton-titelbild-als-attachment.mkv', 0.0, False, {'streams': [{'duration': '30.008000', 'start_time': '-0.007000', 'disposition': {'attached_pic': 1}}], 'format': {'duration': '30.008000', 'format_name': 'matroska,webm'}}),
    ('mkv-ton-laeuft-nach.mkv', 30.0, False, {'streams': [{'start_time': '0.000000', 'tags': {'DURATION': '00:00:30.000000000'}}], 'format': {'duration': '90.008000', 'format_name': 'matroska,webm'}}),
  # an end timestamp, so the start offset has to come off
    ('mkv-bild-startet-spaet.mkv', 30.0, False, {'streams': [{'start_time': '3.000000', 'tags': {'DURATION': '00:00:33.000000000'}}], 'format': {'duration': '33.008000', 'format_name': 'matroska,webm'}}),
  # the mov counterpart, where the per-stream duration is a length already and no correction applies
  # (`nb_frames` added afterwards from the same `-itsoffset 3` construction measured on ffmpeg 7.1.1,
  #  which reports start 3.000000, duration 30.000000, format 33.000000 and 750 frames, as here)
    ('mp4-bild-startet-spaet.mp4', 30.0, False, {'streams': [{'duration': '30.000000', 'start_time': '3.000000', 'nb_frames': '750', 'tags': {'language': 'und'}}], 'format': {'duration': '33.000000', 'format_name': 'mov,mp4,m4a,3gp,3g2,mj2'}}),
  # two video tracks of different lengths; the ladder encodes the first one only
    ('mkv-zwei-bildspuren.mkv', 20.0, False, {'streams': [{'start_time': '0.000000', 'tags': {'DURATION': '00:00:20.000000000'}}], 'format': {'duration': '40.000000', 'format_name': 'matroska,webm'}}),
    ('heil.mp4', 60.0, False, {'streams': [{'duration': '60.000000', 'start_time': '0.000000', 'tags': {'language': 'und'}}], 'format': {'duration': '60.000000', 'format_name': 'mov,mp4,m4a,3gp,3g2,mj2'}}),
    ('heil.mov', 60.0, False, {'streams': [{'duration': '60.000000', 'start_time': '0.000000'}], 'format': {'duration': '60.000000', 'format_name': 'mov,mp4,m4a,3gp,3g2,mj2'}}),
    ('heil.avi', 60.04, False, {'streams': [{'duration': '60.040000', 'start_time': '0.000000'}], 'format': {'duration': '60.040000', 'format_name': 'avi'}}),
    ('heil.mkv', 60.0, False, {'streams': [{'start_time': '0.000000', 'tags': {'DURATION': '00:01:00.000000000'}}], 'format': {'duration': '60.023000', 'format_name': 'matroska,webm'}}),
    ('heil.webm', 60.0, False, {'streams': [{'start_time': '0.000000', 'tags': {'DURATION': '00:01:00.000000000'}}], 'format': {'duration': '60.008000', 'format_name': 'matroska,webm'}}),
    ('heil.mpg', 59.96, False, {'streams': [{'duration': '59.960000', 'start_time': '0.540000'}], 'format': {'duration': '59.970911', 'format_name': 'mpeg'}}),
    ('heil.wmv', 60.0, False, {'streams': [{'duration': '60.046000', 'start_time': '0.046000'}], 'format': {'duration': '60.092000', 'format_name': 'asf'}}),
  # an edit list trimming the start
    ('editlist-beschnitten.mp4', 55.0, False, {'streams': [{'duration': '55.000000', 'start_time': '0.000000', 'tags': {'language': 'und'}}], 'format': {'duration': '55.000000', 'format_name': 'mov,mp4,m4a,3gp,3g2,mj2'}}),
    ('bild-startet-spaet.mp4', 30.0, False, {'streams': [{'duration': '30.000000', 'start_time': '3.000000', 'nb_frames': '750', 'tags': {'language': 'und'}}], 'format': {'duration': '33.000000', 'format_name': 'mov,mp4,m4a,3gp,3g2,mj2'}}),
  # the last frame held to the end of the file
    ('letztes-bild-gehalten.mp4', 30.0, False, {'streams': [{'duration': '30.000000', 'start_time': '0.000000', 'tags': {'language': 'und'}}], 'format': {'duration': '30.000000', 'format_name': 'mov,mp4,m4a,3gp,3g2,mj2'}}),
    ('bframes-open-gop.mp4', 60.0, False, {'streams': [{'duration': '60.000000', 'start_time': '0.000000', 'tags': {'language': 'und'}}], 'format': {'duration': '60.000000', 'format_name': 'mov,mp4,m4a,3gp,3g2,mj2'}}),
    ('hevc.mp4', 60.0, False, {'streams': [{'duration': '60.000000', 'start_time': '0.000000', 'tags': {'language': 'und'}}], 'format': {'duration': '60.000000', 'format_name': 'mov,mp4,m4a,3gp,3g2,mj2'}}),
    ('interlaced.mp4', 60.0, False, {'streams': [{'duration': '60.000000', 'start_time': '0.000000', 'tags': {'language': 'und'}}], 'format': {'duration': '60.000000', 'format_name': 'mov,mp4,m4a,3gp,3g2,mj2'}}),
  # a genuine 33-bit PTS wrap 3.7s in -- where the last video packet reads 16.2s for 20s of picture
    ('pts-umlauf.mpg', 20.0, False, {'streams': [{'duration': '20.000000', 'start_time': '-3.717689'}], 'format': {'duration': '20.010911', 'format_name': 'mpeg'}}),
    ('fps-240.mp4', 5.0, False, {'streams': [{'duration': '5.000000', 'start_time': '0.000000', 'tags': {'language': 'und'}}], 'format': {'duration': '5.000000', 'format_name': 'mov,mp4,m4a,3gp,3g2,mj2'}}),
    ('fps-23976.mp4', 29.988, False, {'streams': [{'duration': '29.988292', 'start_time': '0.000000', 'tags': {'language': 'und'}}], 'format': {'duration': '30.000000', 'format_name': 'mov,mp4,m4a,3gp,3g2,mj2'}}),
    ('fps-25.mp4', 30.0, False, {'streams': [{'duration': '30.000000', 'start_time': '0.000000', 'tags': {'language': 'und'}}], 'format': {'duration': '30.000000', 'format_name': 'mov,mp4,m4a,3gp,3g2,mj2'}}),
    ('fps-2997.mp4', 29.997, False, {'streams': [{'duration': '29.996633', 'start_time': '0.000000', 'tags': {'language': 'und'}}], 'format': {'duration': '30.000000', 'format_name': 'mov,mp4,m4a,3gp,3g2,mj2'}}),
    ('lang-10min.mp4', 600.0, False, {'streams': [{'duration': '600.000000', 'start_time': '0.000000', 'tags': {'language': 'und'}}], 'format': {'duration': '600.000000', 'format_name': 'mov,mp4,m4a,3gp,3g2,mj2'}}),
    ('lang-20min.mp4', 1200.0, False, {'streams': [{'duration': '1200.000000', 'start_time': '0.000000', 'tags': {'language': 'und'}}], 'format': {'duration': '1200.000000', 'format_name': 'mov,mp4,m4a,3gp,3g2,mj2'}}),
    ('mkv-von-ffmpeg.mkv', 60.0, False, {'streams': [{'start_time': '0.000000', 'tags': {'DURATION': '00:01:00.000000000'}}], 'format': {'duration': '60.023000', 'format_name': 'matroska,webm'}}),
  # a track carrying a language: ffmpeg 7.1.5 writes plain DURATION here, not DURATION-eng
    ('mkv-von-ffmpeg-sprache.mkv', 60.0, False, {'streams': [{'start_time': '0.000000', 'tags': {'language': 'eng', 'DURATION': '00:01:00.000000000'}}], 'format': {'duration': '60.023000', 'format_name': 'matroska,webm'}}),
    ('webm-von-ffmpeg.webm', 60.0, False, {'streams': [{'start_time': '0.000000', 'tags': {'DURATION': '00:01:00.000000000'}}], 'format': {'duration': '60.008000', 'format_name': 'matroska,webm'}}),
  # no video stream at all
    ('nur-ton-im-videocontainer.mp4', None, False, {'streams': [], 'format': {'duration': '60.000000', 'format_name': 'mov,mp4,m4a,3gp,3g2,mj2'}}),
  # Fragmented MP4, where `stream.duration` is an end timestamp rather than a
  # length and `nb_frames` is absent because the sample table in `moov` is empty.
  # Measured with Homebrew's ffmpeg 7.1.1 on an HLS-fMP4 rendition of a 60s
  # 30fps stream (`-hls_segment_type fmp4 -hls_time 4`), the init segment joined
  # to: every segment; segments 6-15, as a live window or a partial download
  # would leave it; segments 2-15. And `-movflags frag_keyframe+empty_moov`
  # output of a 30s 25fps file. Real lengths are the counted packets.
    ('fmp4-alle-segmente.mp4', 60.0, False, {'streams': [{'duration': '60.000000', 'start_time': '0.066016'}], 'format': {'duration': '60.023023', 'format_name': 'mov,mp4,m4a,3gp,3g2,mj2'}}),
    ('fmp4-ab-segment-6.mp4', 40.0, False, {'streams': [{'duration': '60.000000', 'start_time': '20.066016'}], 'format': {'duration': '60.053862', 'format_name': 'mov,mp4,m4a,3gp,3g2,mj2'}}),
    ('fmp4-ab-segment-2.mp4', 56.0, False, {'streams': [{'duration': '60.000000', 'start_time': '4.066016'}], 'format': {'duration': '60.052411', 'format_name': 'mov,mp4,m4a,3gp,3g2,mj2'}}),
    ('fmp4-empty-moov.mp4', 30.0, False, {'streams': [{'duration': '30.000000', 'start_time': '0.080000'}], 'format': {'duration': '33.080000', 'format_name': 'mov,mp4,m4a,3gp,3g2,mj2'}}),
]

# The files whose picture length this code is willing to state. Pinned as a set
# so that both directions are visible in a diff: a container dropping out of it
# means the check went inert there, and one appearing in it means a number is now
# being trusted that was not before.
JUDGED = {
    'mp4-heil.mp4',
    'mp4-gekappt-bildgrenze.mp4',
    'mp4-gekappt-mitten-im-paket.mp4',
    'webm-recorder-nachgebessert.webm',
    'webm-nur-bild-standbild.webm',
    'mkv-stale-duration-eng.mkv',
    'mkv-nur-ton-mit-titelbild.mkv',
    'mkv-ton-laeuft-nach.mkv',
    'mkv-bild-startet-spaet.mkv',
    'mp4-bild-startet-spaet.mp4',
    'mkv-zwei-bildspuren.mkv',
    'heil.mp4',
    'heil.mov',
    'heil.mkv',
    'heil.webm',
    'editlist-beschnitten.mp4',
    'bild-startet-spaet.mp4',
    'letztes-bild-gehalten.mp4',
    'bframes-open-gop.mp4',
    'hevc.mp4',
    'interlaced.mp4',
    'fps-240.mp4',
    'fps-23976.mp4',
    'fps-25.mp4',
    'fps-2997.mp4',
    'lang-10min.mp4',
    'lang-20min.mp4',
    'mkv-von-ffmpeg.mkv',
    'mkv-von-ffmpeg-sprache.mkv',
    'webm-von-ffmpeg.webm',
    'fmp4-alle-segmente.mp4',
    'fmp4-ab-segment-6.mp4',
    'fmp4-ab-segment-2.mp4',
    'fmp4-empty-moov.mp4',
}


@pytest.mark.parametrize("name, real_seconds, truncated, probe",
                         MEASURED, ids=[f[0] for f in MEASURED])
def test_an_intact_file_is_either_declined_or_measured_honestly(
    name, real_seconds, truncated, probe
):
    if truncated:
        pytest.skip("deliberately truncated: held by the test below instead")
    streams = probe["streams"]
    if not streams:
        pytest.skip("no video stream at all: this never reaches the check")
    stated = video_track_seconds(probe, streams[0])
    if stated is None:
        return
    assert real_seconds is not None, f"{name}: measured length unknown"
    assert stated <= real_seconds + _TRUNCATION_SLACK_SECONDS, (
        f"{name}: {stated:.3f}s claimed against {real_seconds:.3f}s of picture "
        f"-- an intact upload would be refused by {stated - real_seconds:.3f}s"
    )
    # And not far below either. Understating is the permissive direction, so it
    # cannot refuse anything -- but a number well under the truth means the check
    # is only pretending to hold this container, and halving every duration would
    # otherwise pass the whole corpus.
    assert stated >= real_seconds - _TRUNCATION_SLACK_SECONDS, (
        f"{name}: {stated:.3f}s claimed against {real_seconds:.3f}s of picture "
        "-- the check would be inert here in all but name"
    )


@pytest.mark.parametrize("name, real_seconds, truncated, probe",
                         [c for c in MEASURED if c[2]],
                         ids=[c[0] for c in MEASURED if c[2]])
def test_a_truncated_file_is_still_caught(name, real_seconds, truncated, probe):
    # The other direction, and the reason "decline everywhere" is not an answer.
    # Both of these are the incident's own shape: an mp4 whose moov is at the
    # front, so the track duration survives the truncation and states what the
    # file was supposed to hold. One was cut on a packet boundary and one inside
    # a packet -- measured with ffmpeg 7.1.5, both exit 0 through the encode
    # pipeline, so neither is louder than the other.
    stated = video_track_seconds(probe, probe["streams"][0])
    assert stated is not None, f"{name}: nothing to compare, the check is inert"
    assert stated > real_seconds + _TRUNCATION_SLACK_SECONDS, (
        f"{name}: {stated:.3f}s against {real_seconds:.3f}s of picture is "
        "inside the slack, so the truncation would pass"
    )


def test_which_containers_are_judged_at_all():
    judged = {name for name, _real, _trunc, probe in MEASURED
              if probe["streams"]
              and video_track_seconds(probe, probe["streams"][0]) is not None}
    assert judged == JUDGED
