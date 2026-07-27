"""Timecode math for comment export (#84): NDF/DF conversion, fps snapping."""
from apps.api.services.comment_export import (
    FPS_TABLE, frames_to_tc, seconds_to_frames, snap_fps, tc_to_frames,
)


def spec_for(timebase, drop):
    return next(s for s in FPS_TABLE if s.timebase == timebase and s.drop_frame == drop)


def test_ndf_25fps_one_hour():
    assert frames_to_tc(90000, spec_for(25, False)) == "01:00:00:00"


def test_df_2997_known_vectors():
    df = spec_for(30, True)
    assert frames_to_tc(1799, df) == "00:00:59;29"
    assert frames_to_tc(1800, df) == "00:01:00;02"
    assert frames_to_tc(17982, df) == "00:10:00;00"


def test_tc_to_frames_roundtrip_df():
    df = spec_for(30, True)
    assert tc_to_frames("00:01:00;02", df) == 1800
    assert tc_to_frames("01:00:00:00", df) == tc_to_frames("01:00:00;00", df)
    assert frames_to_tc(tc_to_frames("01:00:00;00", df), df) == "01:00:00;00"


def test_snap_fps():
    assert snap_fps(29.97).drop_frame is True
    assert snap_fps(23.976).frame_dur_den == 24000
    assert snap_fps(25.0).timebase == 25
    assert snap_fps(12.0) is None
    assert snap_fps(120.0) is None


def test_seconds_to_frames():
    assert seconds_to_frames(10.0, spec_for(60, False)) == 600
    assert seconds_to_frames(2.52, spec_for(25, False)) == 63


def test_df_5994_known_vectors():
    df = spec_for(60, True)
    assert frames_to_tc(3600, df) == "00:01:00;04"
    assert tc_to_frames("00:01:00;04", df) == 3600
    # one hour @ 59.94 DF = 215,784 frames (industry reference constant)
    assert tc_to_frames("01:00:00;00", df) == 215784
    assert frames_to_tc(215784, df) == "01:00:00;00"
