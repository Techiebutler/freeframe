import { ShareErrorState } from '@/components/share/share-error-state'

/**
 * Rendered by `notFound()` from the short-link route: an unknown or deleted
 * code answers a real HTTP 404 with the share page's "Link not found" screen.
 */
export default function ShortCodeNotFound() {
  return <ShareErrorState />
}
