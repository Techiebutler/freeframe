"""What a version can be downloaded as, and which object each choice serves.

A download used to be whatever the server picked: the top rung's MP4 for a
video, the MP3 or WebP for audio and stills. That is a sensible default for a
reviewer on a slow link and the wrong file for an editor who wants the master
back, so a download is now a choice between the original upload and whichever
transcode the version already has as a single file.

Only files that exist are offered. A video's lower rungs are HLS segments with
no single file behind them, so the one transcode a video offers is the MP4 the
transcoder remuxed from its top rung (`s3_key_download`), where there is one.
"""
import os
import re
from dataclasses import dataclass
from typing import Optional

from ..config import settings
from ..models.asset import AssetType, MediaFile
from .s3_service import get_s3_client, head_object_size

ORIGINAL = "original"
TRANSCODE = "transcode"

_RESOLUTION = re.compile(r"RESOLUTION=\d+x(\d+)")


@dataclass
class DownloadChoice:
    id: str
    label: str
    # The container, as the person picking would name it: "MOV", "MP4".
    format: str
    s3_key: str
    size_bytes: Optional[int]


def _format_of(key: Optional[str]) -> str:
    return os.path.splitext(key or "")[1].lstrip(".").upper()


def download_choices(asset_type: AssetType, media_file: MediaFile) -> list[DownloadChoice]:
    """The original first, then the transcode when the version has one as a file."""
    choices = [DownloadChoice(
        id=ORIGINAL,
        label="Original",
        format=_format_of(media_file.s3_key_raw) or _format_of(media_file.original_filename),
        s3_key=media_file.s3_key_raw,
        size_bytes=media_file.file_size_bytes,
    )]

    if asset_type == AssetType.video:
        # No processed prefix means no ladder, and so nothing remuxed from it.
        transcode = media_file.s3_key_download if media_file.s3_key_processed else None
    else:
        # Audio's MP3 and a still's WebP are already single files.
        transcode = media_file.s3_key_processed
    if transcode and transcode != media_file.s3_key_raw:
        choices.append(DownloadChoice(
            id=TRANSCODE,
            label="Transcode",
            format=_format_of(transcode),
            s3_key=transcode,
            size_bytes=None,
        ))
    return choices


def _top_rung_height(hls_prefix: str) -> Optional[int]:
    """The tallest variant in a ladder's master playlist, which is the rung
    the download MP4 was remuxed from."""
    obj = get_s3_client().get_object(Bucket=settings.s3_bucket, Key=f"{hls_prefix}/master.m3u8")
    heights = [int(h) for h in _RESOLUTION.findall(obj["Body"].read().decode("utf-8"))]
    return max(heights) if heights else None


def describe_choices(
    asset_type: AssetType, media_file: MediaFile, choices: list[DownloadChoice],
) -> None:
    """Fill in what a menu shows but a download does not need: a video
    transcode's resolution, and the size of anything that did not record one.

    Best-effort: storage that will not answer must not stop anyone downloading,
    so a failure here leaves the generic label and an unknown size.
    """
    for c in choices:
        if c.id == TRANSCODE and asset_type == AssetType.video:
            try:
                height = _top_rung_height(media_file.s3_key_processed)
            except Exception:  # noqa: BLE001
                height = None
            if height:
                c.label = f"{height}p"
        if c.size_bytes is None:
            try:
                c.size_bytes = head_object_size(c.s3_key)
            except Exception:  # noqa: BLE001
                c.size_bytes = None


def pick_download(
    asset_type: AssetType, media_file: MediaFile, rendition: Optional[str],
) -> Optional[DownloadChoice]:
    """The choice `rendition` names, or None when the version has no such choice.

    With nothing named, the transcode, falling back to the original: the file a
    download served before there was a choice, so a client that does not ask
    gets what it always got.
    """
    choices = download_choices(asset_type, media_file)
    if rendition is None:
        return choices[-1]
    return next((c for c in choices if c.id == rendition), None)

