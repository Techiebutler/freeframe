from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Optional

@dataclass
class TranscodeJob:
    media_id: str
    version_id: str
    input_s3_key: str
    output_s3_prefix: str
    qualities: list[str] = field(default_factory=lambda: ["1080p", "720p", "360p"])

@dataclass
class TranscodeResult:
    success: bool
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
