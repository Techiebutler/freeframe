/**
 * Turning a picked file into the image that gets uploaded as a profile picture.
 *
 * Avatars are drawn as circles at 20–64px all over the app, once per comment,
 * so a phone photo uploaded as-is would be a multi-megabyte download for every
 * comment its author ever wrote. Center-crop to a square and scale down here,
 * once, instead.
 */

export const AVATAR_SIZE = 256
export const AVATAR_MAX_INPUT_BYTES = 10 * 1024 * 1024
export const AVATAR_INPUT_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const

export class AvatarImageError extends Error {}

export async function prepareAvatar(file: File): Promise<Blob> {
  checkInput(file)
  return encode(file, (width, height) => {
    const side = Math.min(width, height)
    const out = Math.min(AVATAR_SIZE, side)
    return { sx: (width - side) / 2, sy: (height - side) / 2, sw: side, sh: side, dw: out, dh: out }
  })
}

/** The longest side a project's share-page logo is stored at. */
export const LOGO_MAX_SIDE = 512

/**
 * Turning a picked file into the project logo that share pages show in their
 * header.
 *
 * Same checks, decoding and WebP encoding as an avatar, but the whole picture
 * is kept: a logo is often a wide wordmark, and a square crop would cut the
 * name off. Scaled so its longest side is at most LOGO_MAX_SIDE, never up.
 */
export async function prepareLogo(file: File): Promise<Blob> {
  checkInput(file)
  return encode(file, (width, height) => {
    const scale = Math.min(1, LOGO_MAX_SIDE / Math.max(width, height))
    return {
      sx: 0,
      sy: 0,
      sw: width,
      sh: height,
      dw: Math.max(1, Math.round(width * scale)),
      dh: Math.max(1, Math.round(height * scale)),
    }
  })
}

function checkInput(file: File): void {
  if (!(AVATAR_INPUT_TYPES as readonly string[]).includes(file.type)) {
    throw new AvatarImageError('Choose a PNG, JPG or WEBP image')
  }
  if (file.size > AVATAR_MAX_INPUT_BYTES) {
    throw new AvatarImageError('Image must be under 10 MB')
  }
}

/** Source rectangle in the decoded picture, and the size it is drawn at. */
interface DrawRect {
  sx: number
  sy: number
  sw: number
  sh: number
  dw: number
  dh: number
}

async function encode(
  file: File,
  rectFor: (width: number, height: number) => DrawRect,
): Promise<Blob> {
  let bitmap: ImageBitmap
  try {
    // `from-image` applies EXIF orientation, so a portrait phone photo
    // doesn't come out on its side.
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    throw new AvatarImageError("That image couldn't be read")
  }

  const { sx, sy, sw, sh, dw, dh } = rectFor(bitmap.width, bitmap.height)
  const canvas = document.createElement('canvas')
  canvas.width = dw
  canvas.height = dh
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    bitmap.close()
    throw new AvatarImageError("That image couldn't be read")
  }
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, dw, dh)
  bitmap.close()

  // Browsers that can't encode WebP (Safari) hand back a PNG instead; the
  // caller signs the upload for whichever type actually came out.
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/webp', 0.9),
  )
  if (!blob) throw new AvatarImageError("That image couldn't be read")
  return blob
}
