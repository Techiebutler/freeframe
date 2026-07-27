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


@dataclass
class CommentRow:
    """One comment, flattened by the router (author already resolved)."""
    id: str
    parent_id: Optional[str]
    author_name: str
    author_email: str
    body: str
    timecode_start: Optional[float]
    timecode_end: Optional[float]
    resolved: bool
    created_at: datetime
    version_number: int


@dataclass
class Marker:
    frames: int
    duration_frames: int
    text: str    # "{author}: {body}", same-frame comments joined with " — "
    note: str    # folded replies, one "— {author}: {body}" per line
    resolved: bool


def _descendants(parent_id: str, children_by_parent: dict) -> list[CommentRow]:
    out: list[CommentRow] = []
    for child in children_by_parent.get(parent_id, []):
        out.append(child)
        out.extend(_descendants(child.id, children_by_parent))
    return out


def build_markers(rows: list[CommentRow], spec: FpsSpec, include_resolved: bool = True) -> list[Marker]:
    """Top-level timecoded comments -> markers; replies fold into the note;
    same-frame markers merge (Resolve drops overlapping point markers)."""
    children_by_parent: dict[str, list[CommentRow]] = {}
    for r in rows:
        if r.parent_id is not None:
            children_by_parent.setdefault(r.parent_id, []).append(r)
    for kids in children_by_parent.values():
        kids.sort(key=lambda r: r.created_at)

    by_frame: dict[int, list[tuple[CommentRow, list[CommentRow]]]] = {}
    for r in rows:
        if r.parent_id is not None or r.timecode_start is None:
            continue
        if not include_resolved and r.resolved:
            continue
        frames = seconds_to_frames(r.timecode_start, spec)
        by_frame.setdefault(frames, []).append((r, _descendants(r.id, children_by_parent)))

    markers: list[Marker] = []
    for frames in sorted(by_frame):
        texts, notes, durations, resolved_flags = [], [], [], []
        for top, replies in by_frame[frames]:
            texts.append(f"{top.author_name}: {top.body}")
            notes.extend(f"— {r.author_name}: {r.body}" for r in replies)
            if top.timecode_end is not None and top.timecode_end > top.timecode_start:
                durations.append(max(1, seconds_to_frames(top.timecode_end, spec) - frames))
            else:
                durations.append(1)
            resolved_flags.append(top.resolved)
        markers.append(Marker(
            frames=frames,
            duration_frames=max(durations),
            text=" — ".join(texts),
            note="\n".join(notes),
            resolved=all(resolved_flags),
        ))
    return markers


CSV_COLUMNS = [
    "comment_id", "parent_id", "version_number", "timecode_smpte",
    "timecode_start_seconds", "timecode_end_seconds",
    "author_name", "author_email", "body", "resolved", "created_at",
]


def to_csv(rows: list[CommentRow], spec: Optional[FpsSpec]) -> str:
    """Flat chronological CSV of ALL comments (replies and untimecoded included)."""
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(CSV_COLUMNS)
    for r in sorted(rows, key=lambda r: r.created_at):
        smpte = ""
        if spec is not None and r.timecode_start is not None:
            smpte = frames_to_tc(seconds_to_frames(r.timecode_start, spec), spec)
        w.writerow([
            r.id, r.parent_id or "", r.version_number, smpte,
            "" if r.timecode_start is None else r.timecode_start,
            "" if r.timecode_end is None else r.timecode_end,
            r.author_name, r.author_email, r.body,
            str(r.resolved).lower(), r.created_at.isoformat(),
        ])
    return buf.getvalue()


EDL_MAX_EVENTS = 999  # CMX 3600 hard limit
_EDL_COLOR_OPEN = "ResolveColorBlue"
_EDL_COLOR_RESOLVED = "ResolveColorGreen"


def _edl_sanitize(text: str) -> str:
    """One line, no pipes; '_' prefix when starting with a digit
    (Resolve ignores markers whose text starts with an Arabic numeral)."""
    text = re.sub(r"[\r\n]+", " ", text).replace("|", "/").strip()
    if text and text[0].isdigit():
        text = "_" + text
    return text


def to_edl(markers: list[Marker], spec: FpsSpec, start_tc_frames: int, title: str) -> str:
    """Resolve 'Import Timeline Markers from EDL' flavor of CMX 3600:
    one event line per marker (out = in + 1 frame always) followed by
    ' |C:<color> |M:<text> |D:<frames>'."""
    title = re.sub(r"\s+", " ", title).strip().replace("|", "/")
    fcm = "DROP FRAME" if spec.drop_frame else "NON-DROP FRAME"
    lines = [f"TITLE: {title}", f"FCM: {fcm}", ""]
    for i, m in enumerate(markers[:EDL_MAX_EVENTS], start=1):
        rec_in = frames_to_tc(start_tc_frames + m.frames, spec)
        rec_out = frames_to_tc(start_tc_frames + m.frames + 1, spec)
        color = _EDL_COLOR_RESOLVED if m.resolved else _EDL_COLOR_OPEN
        text = _edl_sanitize(f"{m.text} — {m.note}" if m.note else m.text)
        lines.append(f"{i:03d}  001      V     C        {rec_in} {rec_out} {rec_in} {rec_out}")
        lines.append(f" |C:{color} |M:{text} |D:{m.duration_frames}")
    return "\n".join(lines) + "\n"


def _rational(frames: int, spec: FpsSpec) -> str:
    """Frame count -> FCPXML rational seconds, always a multiple of frameDuration."""
    return f"{frames * spec.frame_dur_num}/{spec.frame_dur_den}s"


def to_fcpxml(markers: list[Marker], spec: FpsSpec, asset_name: str, total_duration_frames: int) -> str:
    """FCPXML 1.9 with markers on a media-less gap (importable by FCP 10.4+)."""
    last_end = max((m.frames + m.duration_frames for m in markers), default=0)
    gap_frames = max(total_duration_frames, last_end + spec.timebase * 10)

    root = ET.Element("fcpxml", version="1.9")
    resources = ET.SubElement(root, "resources")
    ET.SubElement(resources, "format", id="r1",
                  frameDuration=f"{spec.frame_dur_num}/{spec.frame_dur_den}s",
                  width="1920", height="1080")
    library = ET.SubElement(root, "library")
    event = ET.SubElement(library, "event", name="FreeFrame Comments")
    project = ET.SubElement(event, "project", name=f"{asset_name} — comments")
    sequence = ET.SubElement(project, "sequence", format="r1",
                             duration=_rational(gap_frames, spec),
                             tcStart="0s",
                             tcFormat="DF" if spec.drop_frame else "NDF")
    spine = ET.SubElement(sequence, "spine")
    gap = ET.SubElement(spine, "gap", name="Gap", offset="0s", start="0s",
                        duration=_rational(gap_frames, spec))
    for m in markers:
        attrs = {
            "start": _rational(m.frames, spec),
            "duration": _rational(m.duration_frames, spec),
            "value": m.text,
        }
        if m.note:
            attrs["note"] = m.note
        if m.resolved:
            attrs["completed"] = "1"
        ET.SubElement(gap, "marker", attrs)
    body = ET.tostring(root, encoding="unicode")
    return '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE fcpxml>\n' + body + "\n"


def to_premiere_xml(markers: list[Marker], spec: FpsSpec, asset_name: str, total_duration_frames: int) -> str:
    """FCP7 interchange XML (xmeml) sequence markers — the only file-based
    marker import path Premiere Pro supports."""
    last_end = max((m.frames + m.duration_frames for m in markers), default=0)
    duration = max(total_duration_frames, last_end + spec.timebase * 10)

    def _rate(parent):
        rate = ET.SubElement(parent, "rate")
        ET.SubElement(rate, "timebase").text = str(spec.timebase)
        ET.SubElement(rate, "ntsc").text = "TRUE" if spec.ntsc else "FALSE"

    root = ET.Element("xmeml", version="4")
    seq = ET.SubElement(root, "sequence")
    ET.SubElement(seq, "name").text = f"{asset_name} — comments"
    ET.SubElement(seq, "duration").text = str(duration)
    _rate(seq)
    tc = ET.SubElement(seq, "timecode")
    _rate(tc)
    ET.SubElement(tc, "string").text = "00:00:00:00"
    ET.SubElement(tc, "frame").text = "0"
    ET.SubElement(tc, "displayformat").text = "DF" if spec.drop_frame else "NDF"
    media = ET.SubElement(seq, "media")
    video = ET.SubElement(media, "video")
    ET.SubElement(video, "track")
    for m in markers:
        marker = ET.SubElement(seq, "marker")
        ET.SubElement(marker, "name").text = m.text
        comment_text = (("[resolved] " if m.resolved else "") + m.note).strip()
        ET.SubElement(marker, "comment").text = comment_text
        ET.SubElement(marker, "in").text = str(m.frames)
        ET.SubElement(marker, "out").text = str(-1 if m.duration_frames <= 1 else m.frames + m.duration_frames)
    return '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n' + ET.tostring(root, encoding="unicode") + "\n"
