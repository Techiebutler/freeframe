'use client'

import { InviteAccept } from '@/components/auth/invite-accept'

interface InvitePageProps {
  params: { token: string }
}

export default function InvitePage({ params }: InvitePageProps) {
  const { token } = params
  return <InviteAccept token={token} />
}
