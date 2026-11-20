import { redirect } from 'next/navigation'

export default function InstanceIndexPage() {
  redirect('/settings/instance/users')
}
