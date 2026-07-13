import { getAccessToken } from './auth'

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

export type ExportFormat = 'edl' | 'fcpxml' | 'premiere_xml' | 'csv'

export class FpsRequiredError extends Error {
  constructor() {
    super('Frame rate required')
    this.name = 'FpsRequiredError'
  }
}

const EXT: Record<ExportFormat, string> = {
  edl: 'edl',
  fcpxml: 'fcpxml',
  premiere_xml: 'xml',
  csv: 'csv',
}

export async function exportComments(opts: {
  assetId: string
  versionId: string
  format: ExportFormat
  fps?: number
  includeResolved?: boolean
}): Promise<void> {
  const params = new URLSearchParams({ format: opts.format, version_id: opts.versionId })
  if (opts.fps) params.set('fps', String(opts.fps))
  if (opts.includeResolved === false) params.set('include_resolved', 'false')

  const res = await fetch(`${API_URL}/assets/${opts.assetId}/comments/export?${params}`, {
    headers: { Authorization: `Bearer ${getAccessToken()}` },
  })

  if (res.status === 422) {
    const body = await res.json().catch(() => null)
    if (body?.detail?.code === 'fps_required') throw new FpsRequiredError()
    throw new Error(typeof body?.detail === 'string' ? body.detail : 'Export failed')
  }
  if (!res.ok) throw new Error(`Export failed (${res.status})`)

  const blob = await res.blob()
  const match = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = match?.[1] || `comments.${EXT[opts.format]}`
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  setTimeout(() => {
    a.remove()
    URL.revokeObjectURL(url)
  }, 1000)
}
