import * as React from 'react'
import { Bot } from 'lucide-react'
import { programLabel } from '@/lib/agents'

/** Text + icon, never colour alone. */
export function ProgramBadge({ program }: { program: string | null | undefined }) {
  const label = programLabel(program)
  if (!label) return null
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-bg-tertiary px-2 py-0.5 text-[0.6875rem] font-medium text-text-secondary">
      <Bot size={11} aria-hidden="true" />
      {label}
    </span>
  )
}
