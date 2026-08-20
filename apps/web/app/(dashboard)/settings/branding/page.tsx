import { redirect } from 'next/navigation'

// Branding lives as a sub-tab of Settings → Admin. This route stays only so older
// bookmarks land on it.
export default function BrandingPage() {
  redirect('/settings/admin?tab=branding')
}
