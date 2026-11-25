import { redirect } from 'next/navigation'

// Project settings moved to Settings → Projects. This route stays so older
// links keep working, and passes `?tab=` through unchanged (an unknown tab
// opens General there).
export default async function LegacyProjectSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ tab?: string | string[] }>
}) {
  const { id } = await params
  const { tab } = await searchParams
  const query = typeof tab === 'string' ? `?tab=${encodeURIComponent(tab)}` : ''
  redirect(`/settings/projects/${id}${query}`)
}
