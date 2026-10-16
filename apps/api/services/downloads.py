"""What a version can be downloaded as, and which object each choice serves.

A download used to be whatever the server picked: the top rung's MP4 for a
video, the MP3 or WebP for audio and stills. That is a sensible default for a
reviewer on a slow link and the wrong file for an editor who wants the master
back, so a download is now a choice between the original upload and whichever
transcode the version already has as a single file.

Only files that exist are offered. A video's lower rungs are HLS segments with
no single file behind them, so the one transcode a video offers is the MP4 the
transcoder remuxed from its top rung (`s3_key_download`), where there is one.

The original is not for everyone. Project members can always have it; anyone
else (a share-link visitor, a non-member of a public project, a direct share)
gets it only when an admin turns on `allow_original_downloads`. Off, those
callers are served what a download always served them: the transcode, or the
original when the version has no transcode file at all.
"""
import os
import re
from dataclasses import dataclass
from typing import Optional

from fastapi import HTTPException
from sqlalchemy.orm import Session

from ..config import settings
from ..models.asset import Asset, AssetType, MediaFile
from ..models.user import User
from .permissions import get_project_member
from .s3_service import build_download_filename, get_s3_client, head_object_size
from .storage import get_allow_original_downloads

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


class OriginalNotAllowed(Exception):
    """The caller asked for the original and may only have the transcode."""


def _format_of(key: Optional[str]) -> str:
    return os.path.splitext(key or "")[1].lstrip(".").upper()


def may_download_original(db: Session, asset: Asset, user: Optional[User]) -> bool:
    """The asset's creator and project members always may; anyone else only
    when the instance allows it."""
    if user is not None and (
        asset.created_by == user.id or get_project_member(db, asset.project_id, user.id)
    ):
        return True
    return get_allow_original_downloads(db)


def original_allowed_for_download(
    db: Session,
    asset: Asset,
    user: Optional[User],
    rendition: Optional[str],
    prefer_original: bool,
) -> bool:
    """Whether a stream request's download may be the original.

    A file named in the menu follows may_download_original. A bulk download
    (`prefer_original`, nothing named) follows the instance setting alone, for
    members too: it fetches every asset in a selection, so it is the one an
    admin watching egress needs to control. A download that asks for nothing is
    the same file for everyone, so it needs no lookup at all.
    """
    if rendition is not None:
        return may_download_original(db, asset, user)
    if prefer_original:
        return get_allow_original_downloads(db)
    return False


def download_choices(
    asset_type: AssetType, media_file: MediaFile, *, allow_original: bool,
) -> list[DownloadChoice]:
    """The original first, then the transcode when the version has one as a file.

    Without `allow_original` the original is left out, unless the version has no
    transcode file: then it is the only thing a download can be, and is what a
    download served before there was a choice.
    """
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
        if not allow_original:
            choices = choices[1:]
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
            label = _transcode_label(asset_type, media_file)
            if label != "transcode":
                c.label = label
        if c.size_bytes is None:
            try:
                c.size_bytes = head_object_size(c.s3_key)
            except Exception:  # noqa: BLE001
                c.size_bytes = None


def pick_download(
    asset_type: AssetType,
    media_file: MediaFile,
    rendition: Optional[str],
    *,
    allow_original: bool,
    prefer_original: bool = False,
) -> Optional[DownloadChoice]:
    """The choice `rendition` names, or None when the version has no such choice.

    With nothing named, the transcode, falling back to the original: the file a
    download served before there was a choice, so a client that does not ask
    gets what it always got. `prefer_original` (bulk downloads) asks for the
    original wherever the caller may have it, and the default otherwise.

    Raises OriginalNotAllowed when the original is asked for by name and the
    caller may only have the transcode, so the caller can say why.
    """
    choices = download_choices(asset_type, media_file, allow_original=allow_original)
    if rendition is None:
        if prefer_original and choices[0].id == ORIGINAL:
            return choices[0]
        return choices[-1]
    choice = next((c for c in choices if c.id == rendition), None)
    if choice is None and rendition == ORIGINAL and not allow_original:
        raise OriginalNotAllowed()
    return choice


def pick_or_refuse(
    asset: Asset,
    media_file: MediaFile,
    rendition: Optional[str],
    *,
    allow_original: bool,
    prefer_original: bool = False,
) -> DownloadChoice:
    """pick_download for a route: the file a download serves, or the HTTP error
    that says why it can't be had."""
    try:
        choice = pick_download(
            asset.asset_type, media_file, rendition,
            allow_original=allow_original, prefer_original=prefer_original,
        )
    except OriginalNotAllowed:
        raise HTTPException(status_code=403, detail="Original downloads are not enabled on this server")
    if not choice:
        raise HTTPException(status_code=404, detail="Download option not found")
    return choice


def _transcode_label(asset_type: AssetType, media_file: MediaFile) -> str:
    if asset_type == AssetType.video:
        try:
            height = _top_rung_height(media_file.s3_key_processed)
        except Exception:  # noqa: BLE001
            height = None
        if height:
            return f"{height}p"
    return "transcode"


def download_filename(asset: Asset, media_file: MediaFile, choice: DownloadChoice) -> str:
    """The name a download is saved as.

    When the transcode has the original's extension (an MP4 upload and its MP4
    rung), the two would save under the same name, so the transcode says what
    it is: `Portrait (720p).mp4`.
    """
    name = build_download_filename(asset.name, choice.s3_key, media_file.original_filename)
    if choice.id == TRANSCODE and _format_of(choice.s3_key) == (
        _format_of(media_file.s3_key_raw) or _format_of(media_file.original_filename)
    ):
        stem, ext = os.path.splitext(name)
        name = f"{stem} ({_transcode_label(asset.asset_type, media_file)}){ext}"
    return name
