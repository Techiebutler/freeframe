import { redirect } from 'next/navigation'
import { instanceHrefForLegacyTab } from '@/lib/settings-nav'

// The Admin page is now Settings → Instance. This route stays so older
// bookmarks and `?tab=` links land on the matching page.
//
// A server component on purpose: this is a static route, and a client page
// reading `useSearchParams` without a Suspense boundary fails the build.
export default async function LegacyAdminPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string | string[] }>
}) {
  const { tab } = await searchParams
  redirect(instanceHrefForLegacyTab(typeof tab === 'string' ? tab : null))
}
