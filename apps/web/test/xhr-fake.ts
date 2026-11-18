/**
 * A stand-in for XMLHttpRequest, for the part PUTs of the upload store.
 *
 * jsdom's own XHR sends a Blob without any upload progress a test could use,
 * and would try to reach the presigned URL. This one hands each request to a
 * handler instead, which plays the storage backend: it answers with a reply,
 * or rejects for a network error, and may report bytes on the way through
 * `request.progress()` or end the request with `request.expire()`. A handler
 * that never settles is a part still in flight, which only an abort ends.
 *
 * Only what the store uses is modelled, plus what a browser does on its own
 * where the store could get it wrong unnoticed:
 *
 * - a Blob body with a type is sent with that type as its Content-Type, so a
 *   test can see a header the code never set itself;
 * - whether there is an upload listener is decided at `send()`, the spec's
 *   upload listener flag. A handler assigned later gets no progress events in
 *   Chrome or WebKit, and gets none here either;
 * - `send()` before `open()` throws an InvalidStateError;
 * - a reply can leave its ETag unexposed, as a bucket whose CORS rule does not
 *   list it does. `getAllResponseHeaders()` then leaves it out, and
 *   `getResponseHeader('ETag')` logs the browser's "Refused to get unsafe
 *   header" to the console.
 *
 * A handler may also call `request.abort()` itself. That is an abort the
 * browser starts on its own, on window.stop() or a cancelled navigation,
 * without the store's signal.
 */
import { vi } from 'vitest'

export interface PartReply {
  status: number
  statusText?: string
  etag?: string
  /** False for a bucket whose CORS rule does not expose the ETag. */
  exposeEtag?: boolean
}

export type PartHandler = (url: string, request: FakeXhr) => PartReply | Promise<PartReply>

export const ok = (etag: string): PartReply => ({ status: 200, etag })
export const fail = (status = 503, statusText = 'Service Unavailable'): PartReply => ({ status, statusText })

export class FakeXhr {
  static handler: PartHandler = () => new Promise(() => {})

  upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null }
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  ontimeout: (() => void) | null = null
  onabort: (() => void) | null = null

  method = ''
  url = ''
  body: Blob | null = null
  /** Lower-cased, as they would go over the wire. */
  requestHeaders: Record<string, string> = {}
  status = 0
  statusText = ''
  /** As the code under test leaves them, or sets them. */
  timeout = 0
  withCredentials = false
  /** Whether the request ended by `abort()`, rather than by a reply or an error. */
  aborted = false

  private opened = false
  private sent = false
  private settled = false
  private uploadListener = false
  private etag: string | null = null
  private etagExposed = true

  open(method: string, url: string): void {
    this.method = method
    this.url = url
    this.opened = true
  }

  setRequestHeader(name: string, value: string): void {
    this.requestHeaders[name.toLowerCase()] = value
  }

  getResponseHeader(name: string): string | null {
    if (name.toLowerCase() !== 'etag') return null
    if (!this.etagExposed) {
      console.error(`Refused to get unsafe header "${name}"`)
      return null
    }
    return this.etag
  }

  /** Lower-cased and sorted, as a browser lists them, with ETag among others. */
  getAllResponseHeaders(): string {
    const headers = ['content-length: 0', 'content-type: application/xml']
    if (this.etag !== null && this.etagExposed) headers.push(`etag: ${this.etag}`)
    headers.push('x-amz-request-id: tx0001')
    return headers.map((line) => `${line}\r\n`).join('')
  }

  send(body: Blob | null): void {
    if (!this.opened || this.sent) {
      throw new DOMException("Failed to execute 'send': the object's state must be OPENED.", 'InvalidStateError')
    }
    this.uploadListener = this.upload.onprogress !== null
    this.body = body
    this.sent = true
    if (body instanceof Blob && body.type && !('content-type' in this.requestHeaders)) {
      this.requestHeaders['content-type'] = body.type
    }
    Promise.resolve()
      .then(() => FakeXhr.handler(this.url, this))
      .then(
        (reply) => this.reply(reply),
        () => this.networkError(),
      )
  }

  abort(): void {
    if (!this.sent || this.settled) return
    this.settled = true
    this.aborted = true
    this.onabort?.()
  }

  /**
   * Reports `loaded` bytes of the body as sent, to an upload listener that was
   * there at `send()`. One assigned later hears nothing, as in a browser.
   */
  progress(loaded: number): void {
    if (this.settled || !this.uploadListener) return
    const total = this.body?.size ?? 0
    this.upload.onprogress?.({ loaded, total, lengthComputable: true } as ProgressEvent)
  }

  /** Ends the request as its timeout would. */
  expire(): void {
    if (this.settled) return
    this.settled = true
    this.ontimeout?.()
  }

  private reply({ status, statusText = '', etag, exposeEtag = true }: PartReply): void {
    if (this.settled) return
    this.settled = true
    this.status = status
    this.statusText = statusText
    this.etag = etag ?? null
    this.etagExposed = exposeEtag
    this.onload?.()
  }

  private networkError(): void {
    if (this.settled) return
    this.settled = true
    this.onerror?.()
  }
}

/**
 * Puts the fake in place of XMLHttpRequest and routes every request to
 * `handler`. Returns the requests in the order they were opened.
 */
export function installXhrFake(handler: PartHandler): FakeXhr[] {
  const requests: FakeXhr[] = []
  FakeXhr.handler = handler
  vi.stubGlobal(
    'XMLHttpRequest',
    class extends FakeXhr {
      constructor() {
        super()
        requests.push(this)
      }
    },
  )
  return requests
}
