/**
 * Thumbnail that scrubs the video as the pointer moves across it, the way the
 * FreeFrame web grid and Frame.io do — silent, with a line marking the position.
 *
 * The video element is built on hover and torn down on leave, so a grid of
 * cards costs nothing until one is actually pointed at, and only ever one
 * stream is live at a time.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { FreeFrameApi } from "../../lib/freeframe/api";

/** Stream URLs are presigned and short-lived, but fine to reuse for a session. */
const urlCache = new Map<string, string>();

export const ScrubThumb = ({
  api,
  assetId,
  versionId,
  thumbnailUrl,
  alt = "",
  children,
}: {
  api: FreeFrameApi;
  assetId: string;
  versionId?: string;
  thumbnailUrl?: string | null;
  alt?: string;
  /** Badges and overlays drawn on top of the picture. */
  children?: React.ReactNode;
}) => {
  const [hovering, setHovering] = useState(false);
  const [ready, setReady] = useState(false);
  const [ratio, setRatio] = useState(0);
  // Fade the poster in once decoded instead of letting it pop in; a cached
  // image is complete on mount and shows at once.
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const imageLoaded = !!thumbnailUrl && loadedUrl === thumbnailUrl;
  const markLoaded = useCallback(() => setLoadedUrl(thumbnailUrl ?? null), [thumbnailUrl]);
  const imgRef = useCallback(
    (node: HTMLImageElement | null) => {
      if (node?.complete && node.naturalWidth > 0) markLoaded();
    },
    [markLoaded]
  );
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<{ destroy: () => void } | null>(null);
  const lastSeek = useRef(0);

  const teardown = useCallback(() => {
    hlsRef.current?.destroy();
    hlsRef.current = null;
    setReady(false);
    setRatio(0);
  }, []);

  useEffect(() => {
    if (!hovering) {
      teardown();
      return;
    }
    let cancelled = false;

    (async () => {
      try {
        let src = urlCache.get(assetId);
        if (!src) {
          const stream = await api.stream(assetId, versionId);
          src = stream.url;
          urlCache.set(assetId, src);
        }
        if (cancelled || !videoRef.current) return;

        if (!src.includes(".m3u8")) {
          videoRef.current.src = src;
          setReady(true);
          return;
        }
        const { default: Hls } = await import("hls.js");
        if (cancelled || !videoRef.current || !Hls.isSupported()) return;
        // Lowest rendition: this is a thumbnail, not playback.
        const hls = new Hls({ enableWorker: false, startLevel: 0, capLevelToPlayerSize: true });
        hls.loadSource(src);
        hls.attachMedia(videoRef.current);
        hlsRef.current = hls;
        setReady(true);
      } catch (e) {
        // Without a stream the static thumbnail simply stays put.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [hovering, api, assetId, versionId, teardown]);

  useEffect(() => teardown, [teardown]);

  const onMove = (event: React.MouseEvent<HTMLSpanElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const next = Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width));
    setRatio(next);

    const video = videoRef.current;
    const now = Date.now();
    // A seek per mousemove stalls the decoder; ~12/s is smooth enough.
    if (video && video.duration && now - lastSeek.current > 80) {
      lastSeek.current = now;
      try {
        video.currentTime = next * video.duration;
      } catch (e) {
        // Seeking before the media is ready throws; the next move retries.
      }
    }
  };

  return (
    <span
      className={`scrub-thumb${thumbnailUrl && !imageLoaded ? " loading" : ""}`}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      onMouseMove={onMove}
    >
      {thumbnailUrl ? (
        <img
          key={thumbnailUrl}
          ref={imgRef}
          src={thumbnailUrl}
          alt={alt}
          decoding="async"
          className={imageLoaded ? "loaded" : ""}
          onLoad={markLoaded}
          onError={markLoaded}
        />
      ) : null}
      {hovering && (
        <video
          ref={videoRef}
          className={`scrub-video${ready ? " on" : ""}`}
          muted
          playsInline
          preload="auto"
        />
      )}
      {hovering && ready && (
        <span className="scrub-line" style={{ left: `${ratio * 100}%` }} />
      )}
      {children}
    </span>
  );
};
