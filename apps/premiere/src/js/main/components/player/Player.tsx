/**
 * Video player for the review tab: HLS playback plus a scrub bar that shows
 * where every comment sits, the way the FreeFrame web viewer does.
 */
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import type { FreeFrameApi } from "../../../lib/freeframe/api";
import type { Comment } from "../../../lib/freeframe/types";
import { buildCommentNumbers } from "../../../lib/freeframe/comment-numbers";
import { formatTimecode } from "../../../lib/freeframe/timecode";
import { AnnotationOverlay } from "../AnnotationOverlay";
import { PlayerControls } from "./PlayerControls";
import { PlayerTimeline } from "./PlayerTimeline";
import { type QualityLevel, type TimeMode } from "./player-types";

interface HlsController {
  currentLevel: number;
  levels: Omit<QualityLevel, "index">[];
  destroy: () => void;
}

export interface PlayerHandle {
  seek: (seconds: number) => void;
  currentTime: () => number;
}

interface PlayerProps {
  api: FreeFrameApi;
  assetId: string;
  versionId: string;
  comments: Comment[];
  fps?: number;
  /** Fabric drawing to replay over the picture, or null for none. */
  annotation?: Record<string, unknown> | null;
  selectedTimeRange?: { start: number; end: number } | null;
  onSelectedTimeRangeChange?: (range: { start: number; end: number } | null) => void;
  onTimeUpdate?: (seconds: number) => void;
  onSelectComment?: (comment: Comment) => void;
}

export const Player = forwardRef<PlayerHandle, PlayerProps>(
  (
    {
      api,
      assetId,
      versionId,
      comments,
      fps,
      annotation,
      selectedTimeRange,
      onSelectedTimeRangeChange,
      onTimeUpdate,
      onSelectComment,
    },
    ref
  ) => {
    const videoRef = useRef<HTMLVideoElement>(null);
    const [src, setSrc] = useState("");
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(true);
    const [playing, setPlaying] = useState(false);
    const [muted, setMuted] = useState(false);
    const [volume, setVolume] = useState(1);
    const [loop, setLoop] = useState(false);
    const [speed, setSpeed] = useState(1);
    const [quality, setQuality] = useState<number | null>(null);
    const [qualityLevels, setQualityLevels] = useState<QualityLevel[]>([]);
    const [time, setTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [dragging, setDragging] = useState(false);
    const [timeMode, setTimeMode] = useState<TimeMode>("timecode");
    const [preview, setPreview] = useState<{ x: number; time: number } | null>(null);
    const [previewReady, setPreviewReady] = useState(false);
    const [hoveredCommentId, setHoveredCommentId] = useState<string | null>(null);
    const scrubRef = useRef<HTMLDivElement>(null);
    const previewRef = useRef<HTMLVideoElement>(null);
    const previewHls = useRef<{ destroy: () => void } | null>(null);
    const previewGeneration = useRef(0);
    const hlsRef = useRef<HlsController | null>(null);
    const previewAttached = useRef(false);
    const lastPreviewSeek = useRef(0);
    const previewTarget = useRef(0);
    const lastAnimationUpdate = useRef(0);

    useImperativeHandle(ref, () => ({
      seek: (seconds: number) => {
        const video = videoRef.current;
        if (!video) return;
        video.currentTime = seconds;
        setTime(seconds);
      },
      currentTime: () => videoRef.current?.currentTime ?? 0,
    }));

    useEffect(() => {
      let cancelled = false;
      setLoading(true);
      setError("");
      setSrc("");
      setQuality(null);
      setQualityLevels([]);
      (async () => {
        try {
          const { url } = await api.stream(assetId, versionId || undefined);
          if (!cancelled) setSrc(url);
        } catch (e) {
          if (!cancelled) {
            setError(e instanceof Error ? e.message : String(e));
            setLoading(false);
          }
        }
      })();
      return () => {
        cancelled = true;
      };
    }, [api, assetId, versionId]);

    // CEP's Chromium has no native HLS, so hand .m3u8 sources to hls.js.
    useEffect(() => {
      const video = videoRef.current;
      if (!video || !src) return;
      if (!src.includes(".m3u8")) {
        video.src = src;
        return;
      }
      let disposed = false;
      let destroy = () => {};
      import("hls.js").then(({ default: Hls }) => {
        if (!videoRef.current || disposed) return;
        if (!Hls.isSupported()) {
          setError("HLS playback is unavailable in this panel.");
          return;
        }
        const hls = new Hls({ enableWorker: false });
        hlsRef.current = hls;
        hls.loadSource(src);
        hls.attachMedia(videoRef.current);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          setQualityLevels(
            hls.levels.map((level, index) => ({
              index,
              height: level.height,
              width: level.width,
              bitrate: level.bitrate,
            }))
          );
        });
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (data.fatal) setError(`Playback error: ${data.details}`);
        });
        destroy = () => {
          if (hlsRef.current === hls) hlsRef.current = null;
          hls.destroy();
        };
      });
      return () => {
        disposed = true;
        destroy();
      };
    }, [src]);

    // Rate resets whenever the element gets a new source.
    useEffect(() => {
      if (videoRef.current) videoRef.current.playbackRate = speed;
    }, [speed, src]);

    // CEP emits native `timeupdate` sparsely. Sample the playing video at
    // 30fps so the playhead moves continuously even on short clips.
    useEffect(() => {
      if (!playing) return;
      let frame = 0;
      const tick = (now: number) => {
        const video = videoRef.current;
        if (video && now - lastAnimationUpdate.current >= 33) {
          lastAnimationUpdate.current = now;
          const next = video.currentTime;
          setTime(next);
          onTimeUpdate?.(next);
        }
        if (video && !video.paused) frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(frame);
    }, [playing, onTimeUpdate]);

    const timed = useMemo(
      () =>
        comments.filter(
          (c) => c.timecode_start !== null && c.timecode_start !== undefined
        ),
      [comments]
    );

    const commentNumbers = useMemo(() => buildCommentNumbers(comments), [comments]);

    const togglePlay = useCallback(() => {
      const video = videoRef.current;
      if (!video) return;
      if (video.paused) video.play().catch(() => {});
      else video.pause();
    }, []);

    /** One frame at a time when the rate is known, else a small nudge. */
    const stepFrame = (direction: 1 | -1) => {
      const video = videoRef.current;
      if (!video) return;
      video.pause();
      const delta = fps && fps > 0 ? 1 / fps : 0.04;
      video.currentTime = Math.min(
        duration || video.duration || 0,
        Math.max(0, video.currentTime + delta * direction)
      );
    };

    // -- scrubbing ------------------------------------------------------------

    const timeAt = (clientX: number): number => {
      const bar = scrubRef.current;
      if (!bar || !duration) return 0;
      const bounds = bar.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (clientX - bounds.left) / bounds.width));
      return ratio * duration;
    };

    const onRangeHandleDown = (
      event: React.MouseEvent<HTMLButtonElement>,
      handle: "start" | "end"
    ) => {
      if (!selectedTimeRange || !onSelectedTimeRangeChange) return;
      event.preventDefault();
      event.stopPropagation();
      const fixedStart = selectedTimeRange.start;
      const fixedEnd = selectedTimeRange.end;

      const onMove = (move: MouseEvent) => {
        const at = timeAt(move.clientX);
        onSelectedTimeRangeChange(
          handle === "start"
            ? { start: Math.min(at, fixedEnd), end: fixedEnd }
            : { start: fixedStart, end: Math.max(at, fixedStart) }
        );
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    };

    /** Press and drag anywhere on the bar, the way a video player should feel. */
    const onScrubDown = (event: React.MouseEvent<HTMLDivElement>) => {
      const video = videoRef.current;
      if (!video || !duration) return;
      event.preventDefault();
      setDragging(true);
      video.currentTime = timeAt(event.clientX);

      const onMove = (move: MouseEvent) => {
        video.currentTime = timeAt(move.clientX);
        setTime(video.currentTime);
        showPreview(move.clientX);
      };
      const onUp = () => {
        setDragging(false);
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    };

    /**
     * Hover preview. A second, muted video element is attached lazily the first
     * time the bar is hovered — building it up front would double the HLS
     * buffering for a feature most sessions never touch. Seeks are throttled
     * because a seek per mousemove stalls the decoder.
     */
    const ensurePreview = useCallback(() => {
      const node = previewRef.current;
      if (!node || !src || previewAttached.current) return;
      previewAttached.current = true;
      if (!src.includes(".m3u8")) {
        node.src = src;
        return;
      }
      const generation = previewGeneration.current;
      import("hls.js").then(({ default: Hls }) => {
        // The source changed or the player unmounted while hls.js loaded:
        // creating it now would leak a stream nobody destroys.
        if (generation !== previewGeneration.current) return;
        if (!previewRef.current || !Hls.isSupported()) return;
        // Lowest rendition is plenty for a 160px-wide thumbnail.
        const hls = new Hls({ enableWorker: false, startLevel: 0, capLevelToPlayerSize: true });
        hls.loadSource(src);
        hls.attachMedia(previewRef.current);
        previewHls.current = hls;
      });
    }, [src]);

    const seekPreview = () => {
      const node = previewRef.current;
      if (!node || node.readyState < HTMLMediaElement.HAVE_METADATA) return;
      const limit = Number.isFinite(node.duration) ? node.duration : previewTarget.current;
      try {
        node.currentTime = Math.max(0, Math.min(previewTarget.current, limit));
        setPreviewReady(true);
      } catch {
        // The selected HLS fragment may still be buffering. The next media
        // event or pointer move retries with the same requested timestamp.
      }
    };

    const showPreview = (clientX: number) => {
      const bar = scrubRef.current;
      if (!bar || !duration) return;
      ensurePreview();
      const bounds = bar.getBoundingClientRect();
      const at = timeAt(clientX);
      previewTarget.current = at;
      setPreview({ x: clientX - bounds.left, time: at });

      const node = previewRef.current;
      const now = Date.now();
      if (
        node &&
        node.readyState >= HTMLMediaElement.HAVE_METADATA &&
        now - lastPreviewSeek.current > 55
      ) {
        lastPreviewSeek.current = now;
        seekPreview();
      }
    };

    // Tear the preview stream down with the component or a version change.
    useEffect(() => {
      previewAttached.current = false;
      setPreviewReady(false);
      return () => {
        previewGeneration.current += 1;
        previewHls.current?.destroy();
        previewHls.current = null;
      };
    }, [src]);

    const qualityLabel = (level: QualityLevel) => {
      if (level.height) return `${level.height}p`;
      if (level.width) return `${level.width}w`;
      return `Quality ${level.index + 1}`;
    };

    const chooseQuality = (level: number | null) => {
      setQuality(level);
      const hls = hlsRef.current;
      if (hls) hls.currentLevel = level ?? -1;
    };

    /** The readout honours the format picked in the time dropdown. */
    const readout = (seconds: number): string => {
      if (timeMode === "frames") {
        return String(Math.round(seconds * (fps && fps > 0 ? fps : 25)));
      }
      if (timeMode === "seconds") return formatTimecode(seconds);
      return formatTimecode(seconds, fps);
    };

    return (
      <div className="player">
        <div className="stage">
          <video
            ref={videoRef}
            playsInline
            loop={loop}
            onClick={togglePlay}
            onLoadedMetadata={(e) => {
              setDuration(e.currentTarget.duration || 0);
              setLoading(false);
            }}
            onTimeUpdate={(e) => {
              setTime(e.currentTarget.currentTime);
              onTimeUpdate?.(e.currentTarget.currentTime);
            }}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
          />
          <AnnotationOverlay drawing={annotation ?? null} videoRef={videoRef} />
          {loading && !error && <div className="stage-overlay">Loading…</div>}
          {error && <div className="stage-overlay error">{error}</div>}
        </div>

        <PlayerTimeline
          duration={duration}
          time={time}
          dragging={dragging}
          timedComments={timed}
          commentNumbers={commentNumbers}
          fps={fps}
          selectedTimeRange={selectedTimeRange}
          preview={preview}
          previewReady={previewReady}
          hoveredCommentId={hoveredCommentId}
          scrubRef={scrubRef}
          previewRef={previewRef}
          onScrubDown={onScrubDown}
          onShowPreview={showPreview}
          onHidePreview={() => !dragging && setPreview(null)}
          onRangeHandleDown={onRangeHandleDown}
          onClearRange={() => onSelectedTimeRangeChange?.(null)}
          onSelectComment={onSelectComment}
          onHoverComment={setHoveredCommentId}
          onPreviewMediaReady={seekPreview}
        />

        <PlayerControls
          playing={playing}
          loop={loop}
          muted={muted}
          volume={volume}
          speed={speed}
          quality={quality}
          qualityLevels={qualityLevels}
          timeMode={timeMode}
          time={time}
          duration={duration}
          onStepFrame={stepFrame}
          onTogglePlay={togglePlay}
          onLoopChange={setLoop}
          onMuteToggle={() => {
            const video = videoRef.current;
            if (!video) return;
            video.muted = !video.muted;
            setMuted(video.muted);
          }}
          onVolumeChange={(next) => {
            const video = videoRef.current;
            setVolume(next);
            if (!video) return;
            video.volume = next;
            // Dragging off zero should also lift a previous mute.
            video.muted = next === 0;
            setMuted(video.muted);
          }}
          onSpeedChange={setSpeed}
          onQualityChange={chooseQuality}
          onTimeModeChange={setTimeMode}
          formatTime={readout}
          qualityLabel={qualityLabel}
        />
      </div>
    );
  }
);

Player.displayName = "Player";
