"""Serialize review comments into NLE marker formats (#84).

Pure functions only — no DB, no I/O. The router builds CommentRow objects
and hands them here. Format research (Resolve EDL quirks, FCPXML DTD,
Premiere xmeml) is documented in
docs/superpowers/specs/2026-07-13-comment-export-nle-design.md.
"""
from __future__ import annotations

import csv
import io
import re
from dataclasses import dataclass
from datetime import datetime
from typing import Optional
from xml.etree import ElementTree as ET


@dataclass(frozen=True)
class FpsSpec:
    """One entry of the supported frame-rate table."""
    fps: float           # exact playback rate (e.g. 29.97002997)
    frame_dur_num: int   # FCPXML frameDuration numerator
    frame_dur_den: int   # FCPXML frameDuration denominator
    timebase: int        # EDL/xmeml integer timebase (frames per TC second)
    ntsc: bool           # xmeml <ntsc> flag
    drop_frame: bool     # drop-frame timecode


FPS_TABLE: list[FpsSpec] = [
    FpsSpec(24000 / 1001, 1001, 24000, 24, True, False),   # 23.976
    FpsSpec(24.0, 1, 24, 24, False, False),
    FpsSpec(25.0, 1, 25, 25, False, False),
    FpsSpec(30000 / 1001, 1001, 30000, 30, True, True),    # 29.97 DF
    FpsSpec(30.0, 1, 30, 30, False, False),
    FpsSpec(48.0, 1, 48, 48, False, False),
    FpsSpec(50.0, 1, 50, 50, False, False),
    FpsSpec(60000 / 1001, 1001, 60000, 60, True, True),    # 59.94 DF
    FpsSpec(60.0, 1, 60, 60, False, False),
]


def snap_fps(fps: float) -> Optional[FpsSpec]:
    """Snap a probed/user rate to the nearest supported spec (2% tolerance)."""
    best = min(FPS_TABLE, key=lambda s: abs(s.fps - fps))
    if abs(best.fps - fps) > 0.02 * best.fps:
        return None
    return best


def seconds_to_frames(seconds: float, spec: FpsSpec) -> int:
    return round(seconds * spec.fps)


def frames_to_tc(frames: int, spec: FpsSpec) -> str:
    """Frame count -> SMPTE timecode. Drop-frame uses ';' before FF."""
    tb = spec.timebase
    if spec.drop_frame:
        drop = 2 if tb == 30 else 4
        frames_per_min = tb * 60 - drop
        frames_per_10min = tb * 600 - drop * 9
        chunks, rem = divmod(frames, frames_per_10min)
        if rem < tb * 60:
            minute_in_chunk, frame_in_min = 0, rem
        else:
            rem -= tb * 60
            minute_in_chunk = 1 + rem // frames_per_min
            frame_in_min = rem % frames_per_min + drop
        total_min = chunks * 10 + minute_in_chunk
        hh, mm = divmod(total_min, 60)
        ss, ff = divmod(frame_in_min, tb)
    else:
        ss_total, ff = divmod(frames, tb)
        mm_total, ss = divmod(ss_total, 60)
        hh, mm = divmod(mm_total, 60)
    sep = ";" if spec.drop_frame else ":"
    return f"{hh:02d}:{mm:02d}:{ss:02d}{sep}{ff:02d}"


def tc_to_frames(tc: str, spec: FpsSpec) -> int:
    """SMPTE timecode -> frame count. Accepts ':' or ';' separators."""
    parts = re.split(r"[:;]", tc)
    if len(parts) != 4:
        raise ValueError(f"Bad timecode: {tc!r}")
    hh, mm, ss, ff = (int(p) for p in parts)
    tb = spec.timebase
    total = (hh * 3600 + mm * 60 + ss) * tb + ff
    if spec.drop_frame:
        drop = 2 if tb == 30 else 4
        total_min = hh * 60 + mm
        total -= drop * (total_min - total_min // 10)
    return total
