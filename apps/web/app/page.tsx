import { redirect } from 'next/navigation'

// Authenticated users are served by (dashboard)/page.tsx via the layout.
// Unauthenticated users are redirected to /login by middleware.
// This root page only triggers when someone hits / without the dashboard layout;
// redirect them to the proper entry point.
export default function RootPage() {
  redirect('/login')
}
