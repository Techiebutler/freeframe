import { dbLevel, rmsFloat } from './level-meter'

export interface ActiveRecording {
  stop: () => Promise<Blob>
  /** Throw the recording away: nothing is transcribed, nothing is saved. */
  cancel: () => void
}
export type StartRecording = (onLevel?: (level: number) => void) => Promise<ActiveRecording>

/** Microphone capture via MediaRecorder, with a live level for the meter. Rejects when there is no mic or permission is denied. */
export const startMicRecording: StartRecording = async (onLevel) => {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    throw new Error('recording_unsupported')
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  const rec = new MediaRecorder(stream)
  const chunks: Blob[] = []
  rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data) }
  rec.start()

  // The level is sampled every animation frame (no timer lag), as dB-scaled RMS of the float waveform.
  let raf = 0
  let stopped = false
  let ctx: AudioContext | null = null
  if (onLevel && typeof AudioContext !== 'undefined') {
    try {
      ctx = new AudioContext()
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 512
      analyser.smoothingTimeConstant = 0.2
      ctx.createMediaStreamSource(stream).connect(analyser)
      const buf = new Float32Array(analyser.fftSize)
      const tick = () => {
        if (stopped) return
        analyser.getFloatTimeDomainData(buf)
        onLevel(dbLevel(rmsFloat(buf)))
        raf = requestAnimationFrame(tick)
      }
      raf = requestAnimationFrame(tick)
    } catch { /* no meter, the recording still works */ }
  }
  const release = () => {
    stopped = true
    if (raf) cancelAnimationFrame(raf)
    stream.getTracks().forEach(t => t.stop())
    void ctx?.close().catch(() => {})
  }
  return {
    stop: () => new Promise<Blob>(resolve => {
      rec.onstop = () => { release(); resolve(new Blob(chunks, { type: rec.mimeType || 'audio/webm' })) }
      rec.stop()
    }),
    cancel: () => { rec.onstop = null; try { rec.stop() } catch { /* already stopped */ } release() },
  }
}
