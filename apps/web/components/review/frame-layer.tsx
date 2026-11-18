'use client'

/** The picture shown before the video has a frame: fades out (opacity only, instant under reduced motion) once it does. */
export function FrameLayer({ covered, image }: { covered: boolean; image: string | null }) {
  if (!image) return null
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={image} alt="" aria-hidden data-testid="frame-layer" data-covered={covered ? 'true' : 'false'}
      className="ff-layer pointer-events-none absolute inset-0 h-full w-full object-contain" draggable={false} />
  )
}
