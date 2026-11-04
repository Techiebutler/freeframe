export interface ActiveRecording { stop: () => Promise<Blob> }
export type StartRecording = () => Promise<ActiveRecording>

/** Microphone capture via MediaRecorder. Rejects when there is no mic or permission is denied. */
export const startMicRecording: StartRecording = async () => {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    throw new Error('recording_unsupported')
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  const rec = new MediaRecorder(stream)
  const chunks: Blob[] = []
  rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data) }
  rec.start()
  return {
    stop: () => new Promise<Blob>(resolve => {
      rec.onstop = () => { stream.getTracks().forEach(t => t.stop()); resolve(new Blob(chunks, { type: rec.mimeType || 'audio/webm' })) }
      rec.stop()
    }),
  }
}
