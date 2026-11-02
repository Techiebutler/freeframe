from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Callable, Optional

# How aggressively a review stream is compressed: the five steps the instance
# setting offers, and the CRF offset each one means.
#
# Five steps rather than a CRF box, because CRF is not a number anyone outside
# video encoding has an intuition for. The numbers are the shift applied to
# every rung of the ladder; see TRANSCODER_CRF_OFFSET in
# packages/transcoder/ffmpeg_transcoder.py for what one step is worth.
#
# Level 3 is 0, which is what every instance encoded at before this setting
# existed, so an upgrade changes nothing until someone moves the slider. The
# offsets are a shift of the active ladder, not an absolute CRF: on the default
# 8-bit ladder -8 means CRF 16 / 18 / 22, while a 10-bit TRANSCODER_OUTPUT
# already encodes 8 steps lower and so lands lower again. The compression steps
# are deliberately smaller, because past about CRF 30 a review stream stops
# being worth reviewing.
COMPRESSION_LEVELS: dict[int, int] = {
    1: -8,   # Highest quality
    2: -4,   # Higher quality
    3: 0,    # Balanced -- the default, and what this always did
    4: 3,    # Smaller files
    5: 6,    # Smallest files
}
MIN_COMPRESSION_LEVEL = min(COMPRESSION_LEVELS)
MAX_COMPRESSION_LEVEL = max(COMPRESSION_LEVELS)
DEFAULT_COMPRESSION_LEVEL = 3


def crf_offset_for_level(level: Optional[int]) -> Optional[int]:
    """The CRF offset a compression level means, or None for "not set".

    None in and None out, deliberately: an instance that has never touched the
    setting keeps following `TRANSCODER_CRF_OFFSET`, so "no level" has to stay
    distinguishable from "level 3", which is a real choice that overrides the
    environment with 0. A level off the scale reads as not set rather than
    being clamped, because such a value means something upstream is wrong.
    """
    if level is None:
        return None
    return COMPRESSION_LEVELS.get(int(level))


def level_for_crf_offset(offset: int) -> Optional[int]:
    """The level that means exactly this offset, or None if none does.

    The router sends the answer as `compression_level_effective`, so the
    settings page can place the slider without a second copy of the scale in
    TypeScript. It refuses to approximate: `TRANSCODER_CRF_OFFSET=-5` is a
    deliberate expert value no step names, and putting the thumb on the nearest
    step would claim a setting the instance does not have.
    """
    for level, value in COMPRESSION_LEVELS.items():
        if value == offset:
            return level
    return None


@dataclass
class TranscodeJob:
    media_id: str
    version_id: str
    input_s3_key: str
    output_s3_prefix: str
    qualities: list[str] = field(default_factory=lambda: ["1080p", "720p", "360p"])
    # Called with an integer 0-100 as the transcode advances. Optional so other
    # backends need not implement it, and so callers that don't care pay nothing.
    # Implementations must treat it as best-effort: a raising callback must not
    # fail the transcode.
    progress_cb: Optional[Callable[[int], None]] = None
    # True when the caller has no retry left, i.e. this is the last time the
    # source will be read. It refers to the *task's* attempts, not to the
    # backend fallbacks inside one transcode.
    #
    # It exists so that a check which cannot be certain never becomes the reason
    # a version ends up `failed`. A ladder that comes out short is worth reading
    # again -- a dropped read, an object the store had not finished assembling --
    # but a source that reads short every single time must still be stored, and
    # stored as whatever it produced: the master is the irreplaceable half, a
    # `failed` version is never transcoded again, and no measurement is worth
    # that trade. So the check refuses while a retry is left and accepts
    # with a loud log line when none is.
    #
    # Not quite absolute, and the gap is worth knowing: if the broker will not
    # take the retry message, `process_asset` records the failure at the first
    # attempt instead of rescheduling. That path is older than this flag and
    # applies to every exception a transcode can raise -- but this is the first
    # one an intact upload can produce, so the two now coincide.
    #
    # Defaults to False, which is the safe default for a caller that does not
    # know: it refuses, and a caller with no retries would then see the error.
    final_attempt: bool = False
    # How far to shift the ladder's quality for this job, in CRF steps, or None
    # to use whatever `TRANSCODER_CRF_OFFSET` says. Per job rather than read
    # from the environment inside the transcoder, because the setting lives in
    # the database and the worker is long-lived: a change has to reach the next
    # upload, not the next container restart.
    crf_offset: Optional[int] = None

@dataclass
class TranscodeResult:
    success: bool
    # True when the input carries no video stream at all. Distinct from a plain
    # failure: the file is fine, it just is not video, so a caller can re-route
    # it to the audio pipeline instead of surfacing an error.
    no_video_stream: bool = False
    hls_prefix: Optional[str] = None
    # One MP4 holding the whole of the best rendition, for download. The ladder
    # itself is segments, which cannot be handed to anyone as "the video", so
    # without this the only single file a download has is the camera master.
    # None when the remux failed: the ladder is the product, and a caller is
    # expected to fall back rather than treat the transcode as failed.
    mp4_key: Optional[str] = None
    thumbnail_keys: list[str] = field(default_factory=list)
    waveform_key: Optional[str] = None
    error: Optional[str] = None
    duration_seconds: Optional[float] = None
    width: Optional[int] = None
    height: Optional[int] = None
    fps: Optional[float] = None

@dataclass
class VideoMetadata:
    duration_seconds: float
    width: int
    height: int
    fps: float
    # How long the *video* track runs, which is not the same question as how
    # long the file runs: a container's duration is its longest stream, so a
    # rough cut whose audio outlives its picture reports the audio. Anything
    # comparing against the video timeline -- an HLS ladder's own EXTINF sum,
    # for one -- has to ask this instead. None when it cannot be established,
    # which is a real outcome and not an error: see parse_probe_metadata.
    video_duration_seconds: Optional[float] = None

class BaseTranscoder(ABC):
    @abstractmethod
    async def transcode(self, job: TranscodeJob) -> TranscodeResult:
        pass

    @abstractmethod
    async def get_video_metadata(self, s3_key: str) -> VideoMetadata:
        pass

    @abstractmethod
    async def generate_thumbnails(self, s3_key: str, count: int) -> list[str]:
        pass

    @abstractmethod
    async def generate_waveform(self, s3_key: str) -> dict:
        pass
