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
  if (!(AVATAR_INPUT_TYPES as readonly string[]).includes(file.type)) {
    throw new AvatarImageError('Choose a PNG, JPG or WEBP image')
  }
  if (file.size > AVATAR_MAX_INPUT_BYTES) {
    throw new AvatarImageError('Image must be under 10 MB')
  }

  let bitmap: ImageBitmap
  try {
    // `from-image` applies EXIF orientation, so a portrait phone photo
    // doesn't come out on its side.
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    throw new AvatarImageError("That image couldn't be read")
  }

  const side = Math.min(bitmap.width, bitmap.height)
  const out = Math.min(AVATAR_SIZE, side)
  const canvas = document.createElement('canvas')
  canvas.width = out
  canvas.height = out
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    bitmap.close()
    throw new AvatarImageError("That image couldn't be read")
  }
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(
    bitmap,
    (bitmap.width - side) / 2,
    (bitmap.height - side) / 2,
    side,
    side,
    0,
    0,
    out,
    out,
  )
  bitmap.close()

  // Browsers that can't encode WebP (Safari) hand back a PNG instead; the
  // caller signs the upload for whichever type actually came out.
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/webp', 0.9),
  )
  if (!blob) throw new AvatarImageError("That image couldn't be read")
  return blob
}
