import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { copyToClipboard } from '../utils'

/**
 * A stand-in for the browser's clipboard on a plain-HTTP origin, where
 * `navigator.clipboard` does not exist. `document.execCommand('copy')` fires a
 * cancelable `copy` event; if a listener cancels it, whatever the listener set
 * on `clipboardData` is copied, otherwise the current selection is (here, the
 * selected part of the focused textarea, or nothing). That is what Chromium,
 * Firefox and WebKit do.
 */
let clipboard: string | null
let execCommand: ReturnType<typeof vi.fn>

function simulatedCopy(): boolean {
  const data: Record<string, string> = {}
  const event = new Event('copy', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', {
    value: { setData: (type: string, value: string) => { data[type] = value } },
  })
  const target = document.activeElement ?? document.body
  const notCancelled = target.dispatchEvent(event)
  if (!notCancelled) {
    clipboard = data['text/plain'] ?? ''
  } else {
    const el = document.activeElement
    clipboard = el instanceof HTMLTextAreaElement
      ? el.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0)
      : ''
  }
  return true
}

function setClipboardApi(api: { writeText: (t: string) => Promise<void> } | undefined) {
  Object.defineProperty(navigator, 'clipboard', { value: api, configurable: true })
}

const nativeSelect = HTMLTextAreaElement.prototype.select

describe('copyToClipboard', () => {
  beforeEach(() => {
    // Browsers focus a textarea when it is select()ed; jsdom does not.
    HTMLTextAreaElement.prototype.select = function (this: HTMLTextAreaElement) {
      this.focus()
      nativeSelect.call(this)
    }
    clipboard = null
    execCommand = vi.fn((cmd: string) => cmd === 'copy' && simulatedCopy())
    Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true })
    setClipboardApi(undefined)
  })
  afterEach(() => {
    HTMLTextAreaElement.prototype.select = nativeSelect
    setClipboardApi(undefined)
    document.body.innerHTML = ''
  })

  it('uses the async Clipboard API when the page has it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    setClipboardApi({ writeText })
    expect(await copyToClipboard('https://ff.local/share/abc')).toBe(true)
    expect(writeText).toHaveBeenCalledWith('https://ff.local/share/abc')
    expect(execCommand).not.toHaveBeenCalled()
  })

  it('falls back to execCommand when the Clipboard API refuses', async () => {
    setClipboardApi({ writeText: vi.fn().mockRejectedValue(new DOMException('no', 'NotAllowedError')) })
    expect(await copyToClipboard('fallback-text')).toBe(true)
    expect(clipboard).toBe('fallback-text')
  })

  it('copies the text without a Clipboard API (plain HTTP)', async () => {
    expect(await copyToClipboard('lan-text')).toBe(true)
    expect(execCommand).toHaveBeenCalledWith('copy')
    expect(clipboard).toBe('lan-text')
  })

  it('copies the text when a focus trap steals focus from the textarea', async () => {
    // What a Radix dialog does: any focus outside it is pulled straight back.
    const dialog = document.createElement('div')
    const button = document.createElement('button')
    dialog.appendChild(button)
    document.body.appendChild(dialog)
    button.focus()
    const trap = (e: FocusEvent) => {
      if (!dialog.contains(e.target as Node)) button.focus()
    }
    document.addEventListener('focusin', trap)
    try {
      expect(await copyToClipboard('inside-dialog')).toBe(true)
      expect(clipboard).toBe('inside-dialog')
    } finally {
      document.removeEventListener('focusin', trap)
    }
  })

  it('returns false when the copy command did not run', async () => {
    execCommand.mockReturnValue(false)
    expect(await copyToClipboard('x')).toBe(false)
  })

  it('returns false when execCommand reports success but no copy happened', async () => {
    // e.g. a browser that answers true without firing the copy event.
    execCommand.mockReturnValue(true)
    expect(await copyToClipboard('x')).toBe(false)
  })

  it('returns false when execCommand throws', async () => {
    execCommand.mockImplementation(() => { throw new Error('SecurityError') })
    expect(await copyToClipboard('x')).toBe(false)
  })

  it('cleans up: no textarea left, no listener left, focus back where it was', async () => {
    const button = document.createElement('button')
    document.body.appendChild(button)
    button.focus()
    await copyToClipboard('once')
    expect(document.querySelector('textarea')).toBeNull()
    expect(document.activeElement).toBe(button)

    // A later, unrelated copy is not rewritten by a leftover listener.
    const textarea = document.createElement('textarea')
    textarea.value = 'user selection'
    document.body.appendChild(textarea)
    textarea.focus()
    textarea.setSelectionRange(0, textarea.value.length)
    simulatedCopy()
    expect(clipboard).toBe('user selection')
  })
})
