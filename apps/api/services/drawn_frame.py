"""The frame a reviewer drew on, as a PNG: the exact version's frame at the mark's time, strokes burned in.

Server-side (spec 2026-11-18, option 2): runs for every drawing whatever the reviewer's browser did. Pure parts
(clustering, burn-in, source choice) are testable without ffmpeg or storage; `extract_frame` is the one ffmpeg call.
"""
import io
import logging
import math
import subprocess
import tempfile
from dataclasses import dataclass
from typing import Callable, Optional

logger = logging.getLogger("apps.api.drawn_frame")

INK_FRAME_TOL = 0.25            # ink.ts INK_FRAME_TOL: marks this close in video time share one frame
MAX_SIDE = 1280                 # drawn-frame.ts MAX_SIDE
REF_SHORT_SIDE = 360            # ink widths are screen px on a ~360 px wide player
DOT_PX = 8
STROKE_WIDTHS = [7, 6.6, 6.2, 5.8, 5.4, 5, 4.6]
CONTOUR_WIDTH = round((sum(STROKE_WIDTHS) / len(STROKE_WIDTHS) + 3) * 10) / 10
CONTOUR = (15, 23, 42, 140)     # rgba(15,23,42,.55)
CORE = (255, 45, 45, 255)       # red: what the agents' tooling expects (the client JPEG was white)
SUPERSAMPLE = 2
FFMPEG_TIMEOUT_S = 60
PROXY_NAMES = ("review_540.mp4", "ai_proxy.mp4")


@dataclass
class Frame:
    t: float
    mark_ids: list[str]
    marks: list[dict]


def marks_of(drawing_data) -> list[dict]:
    marks = drawing_data.get("marks") if isinstance(drawing_data, dict) else None
    return [m for m in (marks or []) if isinstance(m, dict) and isinstance(m.get("points"), list) and m["points"]]


def mark_id(index: int) -> str:
    return f"m{index}"


def cluster_marks(drawing_data) -> list[Frame]:
    """One Frame per distinct picture: marks whose `t` are within INK_FRAME_TOL of the cluster's first mark share it.
    `t` is a mark's own video time, never the comment's t_start. Marks without a `t` are skipped (nothing to extract)."""
    frames: list[Frame] = []
    raw = drawing_data.get("marks") if isinstance(drawing_data, dict) else None
    for i, m in enumerate(raw or []):
        if not (isinstance(m, dict) and isinstance(m.get("points"), list) and m["points"]) or not isinstance(m.get("t"), (int, float)):
            continue
        for f in frames:
            if abs(f.t - m["t"]) <= INK_FRAME_TOL:
                f.mark_ids.append(mark_id(i)); f.marks.append(m)
                break
        else:
            frames.append(Frame(t=round(float(m["t"]), 3), mark_ids=[mark_id(i)], marks=[m]))
    return frames


def _thin(points: list, min_dist: float = 0.004) -> list:
    if len(points) < 3:
        return points
    out = [points[0]]
    for p in points[1:-1]:
        if math.hypot(p[0] - out[-1][0], p[1] - out[-1][1]) >= min_dist:
            out.append(p)
    out.append(points[-1])
    return out


def _quad(p0, c, p1, steps=8):
    return [((1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * c[0] + t * t * p1[0], (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * c[1] + t * t * p1[1])
            for t in (i / steps for i in range(1, steps + 1))]


def _path(points: list, w: float, h: float) -> list:
    """drawMarks' path: quadratic curves through the midpoints of the captured points, sampled to a polyline."""
    p = [(x * w, y * h) for x, y in _thin(points)]
    if not p:
        return []
    out = [p[0]]
    if len(p) == 1:
        return out * 2
    cur = p[0]
    for i in range(1, len(p) - 1):
        end = ((p[i][0] + p[i + 1][0]) / 2, (p[i][1] + p[i + 1][1]) / 2)
        out += _quad(cur, p[i], end)
        cur = end
    out.append(p[-1])
    return out


def _line(draw, pts, width, fill):
    if len(pts) > 1:
        draw.line(pts, fill=fill, width=max(1, round(width)), joint="curve")
    r = width / 2
    for x, y in (pts[0], pts[-1]):  # round caps
        draw.ellipse([x - r, y - r, x + r, y + r], fill=fill)


def burn_in(image, marks: list[dict]):
    """The marks drawn on a copy of `image` (RGB): dark contour, red core, ring for a dot; widths scale like the live ink."""
    from PIL import Image, ImageDraw
    base = image.convert("RGBA")
    w, h = base.size
    k = SUPERSAMPLE
    layer = Image.new("RGBA", (w * k, h * k), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    s = min(w, h) / REF_SHORT_SIDE * k
    avg = sum(STROKE_WIDTHS) / len(STROKE_WIDTHS)
    for m in marks:
        pts = m.get("points") or []
        if not pts:
            continue
        if m.get("k") == "dot":
            x, y = pts[0][0] * w * k, pts[0][1] * h * k
            r = (DOT_PX + 2) * s
            draw.ellipse([x - r, y - r, x + r, y + r], outline=CONTOUR, width=max(1, round(6.5 * s)))
            draw.ellipse([x - r, y - r, x + r, y + r], outline=CORE, width=max(1, round(4 * s)))
            continue
        path = _path(pts, w * k, h * k)
        if not path:
            continue
        _line(draw, path, CONTOUR_WIDTH * s, CONTOUR)
        _line(draw, path, avg * s, CORE)
    layer = layer.resize((w, h), Image.LANCZOS)
    return Image.alpha_composite(base, layer).convert("RGB")


def to_png(image, max_side: int = MAX_SIDE) -> tuple[bytes, int, int]:
    from PIL import Image
    img = image.copy()
    if max(img.size) > max_side:
        img.thumbnail((max_side, max_side), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue(), img.size[0], img.size[1]


def source_candidates(media, *, version_id) -> list[tuple[str, str]]:
    """[(label, s3 key)] to try, best first, for THIS version's media row: the raw master, then the review proxy.
    A media row of another version is never used (the exact-version guarantee)."""
    if media is None or str(media.version_id) != str(version_id):
        return []
    out = []
    if media.s3_key_raw:
        out.append(("raw", media.s3_key_raw))
    if media.s3_key_processed:
        prefix = media.s3_key_processed.rstrip("/")
        out += [("proxy", f"{prefix}/{name}") for name in PROXY_NAMES]
    return out


def extract_frame(src: str, t: float):
    """One frame at `t` seconds from a file path or URL (frame-accurate: single-frame decode after the seek)."""
    from PIL import Image
    with tempfile.NamedTemporaryFile(suffix=".png") as out:
        cmd = ["ffmpeg", "-nostdin", "-y", "-loglevel", "error", "-ss", f"{max(t, 0):.3f}", "-i", src, "-frames:v", "1", "-f", "image2", "-c:v", "png", out.name]
        r = subprocess.run(cmd, capture_output=True, timeout=FFMPEG_TIMEOUT_S)
        data = open(out.name, "rb").read()
        if r.returncode != 0 or not data:
            raise RuntimeError(f"ffmpeg failed: {r.stderr.decode(errors='replace')[-300:]}")
        return Image.open(io.BytesIO(data)).convert("RGB")


def render_frames(drawing_data, *, version_id, sources: list[tuple[str, str]], extract: Callable[[str, float], object]) -> list[dict]:
    """[{t, mark_ids, png, width, height, source}] per distinct frame. `extract(label_key, t)` returns a PIL image;
    each source is tried in order. Raises when a frame cannot be had from any source (the caller marks the comment failed)."""
    out = []
    for f in cluster_marks(drawing_data):
        last: Optional[Exception] = None
        for label, key in sources:
            try:
                img = extract(key, f.t)
                png, w, h = to_png(burn_in(img, f.marks))
                out.append({"t": f.t, "mark_ids": f.mark_ids, "png": png, "width": w, "height": h, "source": label, "version_id": str(version_id)})
                break
            except Exception as e:  # noqa: BLE001 - try the next source
                last = e
        else:
            raise RuntimeError(f"no source gave frame {f.t} of version {version_id}: {last}")
    return out


# ── DB side ────────────────────────────────────────────────────────────────────

def has_renderable_media(db, version_id) -> bool:
    from ..models.asset import MediaFile
    return db.query(MediaFile.id).filter(MediaFile.version_id == version_id).first() is not None


def render_comment(db, comment_id, *, extract: Optional[Callable] = None, put: Optional[Callable] = None, force: bool = False) -> str:
    """Render every distinct drawn frame of a comment from the exact version it was written on and store each as a
    `frame_png` attachment. Idempotent: a comment that already has its PNGs is left alone. Returns 'done'|'failed'|'skipped'."""
    import re
    import time
    import uuid
    from datetime import datetime, timezone
    from ..models.asset import MediaFile
    from ..models.comment import Annotation, Comment, CommentAttachment
    from . import s3_service

    comment = db.get(Comment, comment_id)
    note = db.query(Annotation).filter(Annotation.comment_id == comment_id).first() if comment else None
    if comment is None or note is None or not cluster_marks(note.drawing_data):
        return "skipped"
    existing = db.query(CommentAttachment).filter(CommentAttachment.comment_id == comment_id, CommentAttachment.kind == "frame_png")
    if existing.count() and not force:
        return "skipped"
    started = time.monotonic()
    try:
        media = db.query(MediaFile).filter(MediaFile.version_id == comment.version_id).first()
        sources = source_candidates(media, version_id=comment.version_id)
        if not sources:
            raise RuntimeError("no media for this version")
        do_extract = extract or (lambda key, t: extract_frame(s3_service.generate_presigned_get_url(key, expires_in=900), t))
        rendered = render_frames(note.drawing_data, version_id=comment.version_id, sources=sources, extract=do_extract)
        do_put = put or (lambda key, body: s3_service.put_object(key, body, "image/png"))
        ms = round((time.monotonic() - started) * 1000)
        if force:
            for a in existing.all():
                db.delete(a)
        for r in rendered:
            name = f"frame-{r['t']:.3f}.png"
            key = f"comment-attachments/{comment.id}/{uuid.uuid4()}/{re.sub(r'[^A-Za-z0-9._-]+', '-', name)}"
            do_put(key, r["png"])
            db.add(CommentAttachment(
                comment_id=comment.id, file_type="image/png", s3_key=key, original_filename=name, file_size_bytes=len(r["png"]),
                uploaded_at=datetime.now(timezone.utc), kind="frame_png", version_id=comment.version_id, t=r["t"],
                meta={"mark_ids": r["mark_ids"], "width": r["width"], "height": r["height"], "source": r["source"], "render_ms": ms}))
        comment.frame_status = "done"
        db.commit()
        return "done"
    except Exception:  # noqa: BLE001 - a failed render must release the round, never block it
        db.rollback()
        logger.warning("drawn frame render failed for comment %s", comment_id, exc_info=True)
        comment = db.get(Comment, comment_id)
        if comment is not None:
            comment.frame_status = "failed"
            db.commit()
        return "failed"
