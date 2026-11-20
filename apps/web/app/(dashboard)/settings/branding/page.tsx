import { redirect } from 'next/navigation'

// Branding lives under Settings → Instance. This route stays only so older
// bookmarks land on it.
export default function BrandingPage() {
  redirect('/settings/instance/branding')
}
