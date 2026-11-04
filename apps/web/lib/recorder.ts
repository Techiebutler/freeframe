import { rmsLevel } from './level-meter'

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

  let meter: ReturnType<typeof setInterval> | null = null
  let ctx: AudioContext | null = null
  if (onLevel && typeof AudioContext !== 'undefined') {
    try {
      ctx = new AudioContext()
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 512
      ctx.createMediaStreamSource(stream).connect(analyser)
      const buf = new Uint8Array(analyser.fftSize)
      meter = setInterval(() => { analyser.getByteTimeDomainData(buf); onLevel(rmsLevel(buf)) }, 70)
    } catch { /* no meter, the recording still works */ }
  }
  const release = () => {
    if (meter) clearInterval(meter)
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
