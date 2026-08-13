/**
 * jsdom performs no layout, so every geometry property on an element reads 0 and
 * a component that measures its own DOM has nothing to measure. These helpers
 * describe a laid-out element on the relevant prototype, letting the component's
 * real effect read real numbers, then put the originals back.
 *
 * Stubbing the prototype rather than an instance because the components under
 * test create the elements internally. Where a test needs two elements to report
 * DIFFERENT geometry, stub the shared baseline here and then override the
 * specific node with Object.defineProperty — see wipe-viewer.test.tsx.
 */
const restores: Array<() => void> = []

/** Geometry keys live on the media prototypes; layout keys on HTMLElement. */
function prototypeFor(key: string): object {
  if (key.startsWith('natural')) return HTMLImageElement.prototype
  if (key.startsWith('video')) return HTMLVideoElement.prototype
  return HTMLElement.prototype
}

/**
 * Describes a laid-out element, e.g.
 * `stubGeometry({ naturalWidth: 100, offsetWidth: 800 })`.
 * Pair with `restoreGeometry()` in an afterEach.
 */
export function stubGeometry(props: Record<string, number>): void {
  for (const [key, value] of Object.entries(props)) {
    const proto = prototypeFor(key)
    const original = Object.getOwnPropertyDescriptor(proto, key)
    Object.defineProperty(proto, key, { value, configurable: true })
    restores.push(() => {
      if (original) Object.defineProperty(proto, key, original)
      else delete (proto as unknown as Record<string, unknown>)[key]
    })
  }
}

/** Undoes every stubGeometry call made since the last restore. */
export function restoreGeometry(): void {
  restores.splice(0).forEach((restore) => restore())
}
