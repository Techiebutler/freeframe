from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Callable, Optional

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

@dataclass
class TranscodeResult:
    success: bool
    # True when the input carries no video stream at all. Distinct from a plain
    # failure: the file is fine, it just is not video, so a caller can re-route
    # it to the audio pipeline instead of surfacing an error.
    no_video_stream: bool = False
    hls_prefix: Optional[str] = None
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
