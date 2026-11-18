import { cn } from '@/lib/utils'
import {
  verdictCountToneLabel,
  verdictTone,
  VERDICT_TONE_DOT_CLASS,
  VERDICT_TONE_TEXT_CLASS,
} from '@/lib/verdicts'
import type { VerdictSummary } from '@/types'

/**
 * A dot and a count in the colour of the most serious verdict, for the grid
 * card. No popover: clicking the card opens the asset, where the indicator is.
 */
export function VerdictBadge({ summary }: { summary?: VerdictSummary | null }) {
  if (!summary) return null
  const tone = verdictTone(summary)
  if (!tone) return null

  const count = summary.approved + summary.changes_requested + summary.rejected
  const label = verdictCountToneLabel(count, tone)

  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-tone={tone}
      className={cn(
        'inline-flex items-center gap-1 text-2xs font-medium tabular-nums',
        VERDICT_TONE_TEXT_CLASS[tone],
      )}
    >
      <span aria-hidden className={cn('h-1.5 w-1.5 rounded-full', VERDICT_TONE_DOT_CLASS[tone])} />
      {count}
    </span>
  )
}
