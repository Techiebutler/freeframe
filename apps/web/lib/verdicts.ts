import type { Verdict, VerdictSummary, VerdictValue } from '@/types'

/** The colour a set of verdicts reads as: the most serious one wins. */
export type VerdictTone = 'rejected' | 'changes' | 'approved'

/** How each verdict reads to people. */
export const VERDICT_LABEL: Record<VerdictValue, string> = {
  approved: 'Approved',
  changes_requested: 'Changes needed',
  rejected: 'Rejected',
}

/**
 * Any rejection makes it `rejected`, otherwise any request for changes makes it
 * `changes`, otherwise any approval makes it `approved`. No verdicts, no tone.
 * Takes either the counts a listing carries or the verdicts themselves.
 */
export function verdictTone(counts: Partial<VerdictSummary> | Verdict[]): VerdictTone | null {
  const has = (value: VerdictValue): boolean =>
    Array.isArray(counts)
      ? counts.some((v) => v.status === value)
      : (counts[value] ?? 0) > 0

  if (has('rejected')) return 'rejected'
  if (has('changes_requested')) return 'changes'
  if (has('approved')) return 'approved'
  return null
}

/** The tone a single verdict reads as. */
export const VERDICT_VALUE_TONE: Record<VerdictValue, VerdictTone> = {
  approved: 'approved',
  changes_requested: 'changes',
  rejected: 'rejected',
}

/** Status colour tokens, never raw hex, so light and dark both follow the theme. */
export const VERDICT_TONE_TEXT_CLASS: Record<VerdictTone, string> = {
  approved: 'text-status-success',
  changes: 'text-status-warning',
  rejected: 'text-status-error',
}

export const VERDICT_TONE_DOT_CLASS: Record<VerdictTone, string> = {
  approved: 'bg-status-success',
  changes: 'bg-status-warning',
  rejected: 'bg-status-error',
}

/** "3 verdicts", for assistive tech where only an icon and a number show. */
export function verdictCountLabel(count: number): string {
  return `${count} ${count === 1 ? 'verdict' : 'verdicts'}`
}

/** Each tone in the words its verdict reads as, so no label is a second copy. */
const TONE_LABEL: Record<VerdictTone, string> = {
  approved: VERDICT_LABEL.approved,
  changes: VERDICT_LABEL.changes_requested,
  rejected: VERDICT_LABEL.rejected,
}

/**
 * "3 verdicts, changes needed": the count and the tone it is coloured in, for
 * assistive tech. Colour alone must not be what says rejected from approved.
 */
export function verdictCountToneLabel(count: number, tone: VerdictTone): string {
  return `${verdictCountLabel(count)}, ${TONE_LABEL[tone].toLowerCase()}`
}

/**
 * The SWR key for the verdicts on one version. One builder, because the asset
 * page revalidates it from an SSE event and a key that differs by a character
 * is a revalidation that silently does nothing.
 */
export function verdictsKey(assetId: string, versionId: string): string {
  return `/assets/${assetId}/verdicts?version_id=${versionId}`
}
