/**
 * prepareAvatar turns a picked file into the 256px square that's uploaded.
 * jsdom has no image decoding or canvas, so both are stubbed and the test
 * checks what prepareAvatar asks of them: the type and size checks, EXIF
 * orientation, the centre crop, and never scaling a small picture up.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AvatarImageError, prepareAvatar, prepareLogo } from '../avatar-image'

function file(type: string, size = 1000): File {
  const f = new File(['x'], 'pic', { type })
  Object.defineProperty(f, 'size', { value: size })
  return f
}

let bitmap: { width: number; height: number; close: ReturnType<typeof vi.fn> }
let createImageBitmap: ReturnType<typeof vi.fn>
let drawImage: ReturnType<typeof vi.fn>
let canvas: { width: number; height: number }
let toBlobType: string | undefined

beforeEach(() => {
  bitmap = { width: 400, height: 300, close: vi.fn() }
  createImageBitmap = vi.fn(async () => bitmap)
  vi.stubGlobal('createImageBitmap', createImageBitmap)
  drawImage = vi.fn()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    canvas = this
    return { drawImage, imageSmoothingQuality: 'low' } as unknown as CanvasRenderingContext2D
  } as never)
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((cb, type) => {
    toBlobType = type
    cb(new Blob(['out'], { type: 'image/webp' }))
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('prepareAvatar', () => {
  it.each(['image/gif', 'image/svg+xml', 'application/pdf', ''])('refuses %s', async (type) => {
    await expect(prepareAvatar(file(type))).rejects.toThrow(AvatarImageError)
    expect(createImageBitmap).not.toHaveBeenCalled()
  })

  it('refuses a file over 10 MB before decoding it', async () => {
    await expect(prepareAvatar(file('image/jpeg', 10 * 1024 * 1024 + 1))).rejects.toThrow('under 10 MB')
    expect(createImageBitmap).not.toHaveBeenCalled()
  })

  it('applies EXIF orientation when decoding', async () => {
    await prepareAvatar(file('image/jpeg'))
    expect(createImageBitmap).toHaveBeenCalledWith(expect.any(File), { imageOrientation: 'from-image' })
  })

  it('centre-crops a landscape picture to a 256px square', async () => {
    await prepareAvatar(file('image/png'))

    expect(canvas.width).toBe(256)
    expect(canvas.height).toBe(256)
    // The middle 300x300 of a 400x300 picture.
    expect(drawImage).toHaveBeenCalledWith(bitmap, 50, 0, 300, 300, 0, 0, 256, 256)
    expect(toBlobType).toBe('image/webp')
    expect(bitmap.close).toHaveBeenCalled()
  })

  it('centre-crops a portrait picture from its middle', async () => {
    bitmap = { width: 300, height: 500, close: vi.fn() }
    await prepareAvatar(file('image/webp'))
    expect(drawImage).toHaveBeenCalledWith(bitmap, 0, 100, 300, 300, 0, 0, 256, 256)
  })

  it('does not scale a small picture up', async () => {
    bitmap = { width: 120, height: 100, close: vi.fn() }
    await prepareAvatar(file('image/png'))

    expect(canvas.width).toBe(100)
    expect(drawImage).toHaveBeenCalledWith(bitmap, 10, 0, 100, 100, 0, 0, 100, 100)
  })

  it('reports a file the browser cannot decode', async () => {
    createImageBitmap.mockRejectedValueOnce(new Error('bad'))
    await expect(prepareAvatar(file('image/png'))).rejects.toThrow("couldn't be read")
  })

  it('reports a canvas that will not encode', async () => {
    vi.mocked(HTMLCanvasElement.prototype.toBlob).mockImplementation((cb) => cb(null))
    await expect(prepareAvatar(file('image/png'))).rejects.toThrow("couldn't be read")
  })
})

// A project logo is often a wide wordmark: the whole picture is kept and only
// scaled down, never cropped to a square.
describe('prepareLogo', () => {
  it('keeps a wide logo whole and scales its longest side to 512', async () => {
    bitmap = { width: 2000, height: 500, close: vi.fn() }
    await prepareLogo(file('image/png'))

    expect(canvas.width).toBe(512)
    expect(canvas.height).toBe(128)
    expect(drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 2000, 500, 0, 0, 512, 128)
    expect(toBlobType).toBe('image/webp')
    expect(bitmap.close).toHaveBeenCalled()
  })

  it('does not scale a small logo up', async () => {
    bitmap = { width: 200, height: 80, close: vi.fn() }
    await prepareLogo(file('image/jpeg'))
    expect(drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 200, 80, 0, 0, 200, 80)
  })

  it('applies the same type and size checks as an avatar', async () => {
    await expect(prepareLogo(file('image/gif'))).rejects.toThrow(AvatarImageError)
    await expect(prepareLogo(file('image/png', 10 * 1024 * 1024 + 1))).rejects.toThrow('under 10 MB')
    expect(createImageBitmap).not.toHaveBeenCalled()
  })
})
