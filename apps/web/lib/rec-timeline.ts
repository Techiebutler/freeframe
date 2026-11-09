// What the video did while a voice note was being recorded. The recording clock and the video clock drift apart
// the moment the video pauses (drawing pauses it), is seeked, or plays at a rate other than 1.

export interface TimelinePoint { /** ms since the recording started */ rec_ms: number; video_t: number; playing: boolean; rate: number }

/** Video time at `offsetMs` into the recording: the last event before it, plus elapsed time at its rate while playing. */
export function videoTimeAt(points: TimelinePoint[], offsetMs: number): number {
  if (!points.length) return 0
  let cur = points[0]
  for (const pt of points) { if (pt.rec_ms <= offsetMs) cur = pt; else break }
  const elapsed = Math.max(0, offsetMs - cur.rec_ms) / 1000
  const t = cur.playing ? cur.video_t + elapsed * cur.rate : cur.video_t
  return Math.round(t * 1000) / 1000
}

/** Logs play, pause, seek and rate changes of a video from now on. */
export function trackVideo(video: HTMLVideoElement | null, startedAt: number, now: () => number = Date.now) {
  const points: TimelinePoint[] = []
  const log = (e?: Event) => {
    if (!video) return
    // `waiting` = buffering: the playhead stands still although the video is not paused.
    const stalled = e?.type === 'waiting'
    points.push({ rec_ms: Math.max(0, now() - startedAt), video_t: video.currentTime, playing: !video.paused && !video.ended && !stalled, rate: video.playbackRate || 1 })
  }
  // `playing` and `waiting` matter: after a stall the video is behind the clock, and `play` alone would not say so.
  const events = ['play', 'playing', 'waiting', 'pause', 'seeked', 'ratechange', 'ended'] as const
  log()
  if (video) events.forEach(e => video.addEventListener(e, log))
  return {
    points,
    stop: () => { if (video) events.forEach(e => video.removeEventListener(e, log)) },
  }
}
