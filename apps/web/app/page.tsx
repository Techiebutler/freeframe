import { redirect } from 'next/navigation'

// Root page redirects to projects dashboard.
// If not authenticated, the proxy will redirect to /login.
export default function RootPage() {
  redirect('/projects')
}
