'use client'

import * as React from 'react'
import useSWR from 'swr'
import { Loader2, ScanEye } from 'lucide-react'
import { api } from '@/lib/api'
import { useToast } from '@/components/shared/toast'

interface AutoreviewBrand {
  slug: string
  name: string
}

/** "Open in AutoReview" on Brand rules: the brand's AutoReview page (Brand Loop B3). It used to be its own sidebar
 * entry; Alan (2026-11-08) wants it where the brand's rules are. The link carries a 60 s token, so it is minted on
 * click, never rendered ahead. Hidden when the brand is not linked to AutoReview or Brand Loop is off. */
export function AutoreviewBrandButton({ slug, name }: { slug?: string | null; name: string }) {
  const { data } = useSWR<{ brands: AutoreviewBrand[] }>('/autoreview/brands', () =>
    api.get<{ brands: AutoreviewBrand[] }>('/autoreview/brands'),
  )
  const [pending, setPending] = React.useState(false)
  const toast = useToast()
  const brands = data?.brands ?? []
  const target = brands.find(b => (slug ? b.slug === slug : b.name.trim() === name.trim()))
  if (!target) return null

  const open = async () => {
    if (pending) return
    setPending(true)
    try {
      const { url } = await api.get<{ url: string }>(`/autoreview/link?brand=${encodeURIComponent(target.slug)}`)
      window.location.assign(url)
    } catch {
      setPending(false)
      toast.error("Couldn't open AutoReview. Try again.")
    }
  }
  const Icon = pending ? Loader2 : ScanEye
  return (
    <button type="button" onClick={open} aria-busy={pending || undefined}
      className="inline-flex h-11 items-center gap-2 rounded-xl border border-border px-4 text-[0.8125rem] font-medium text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary">
      <Icon className={pending ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} strokeWidth={1.5} />
      Open in AutoReview
    </button>
  )
}
