import type { SharePermission } from '@/types'

/**
 * A share link has one permission, `view`, `comment` or `approve`. The link
 * settings show it as two switches, Comments and Approvals, and approving is a
 * kind of commenting: a link that lets people approve lets them comment. So
 * the switches are not independent, and every write goes through here so the
 * two can never disagree with what is stored.
 */

/** The permission the two switches stand for. Approvals on implies comments on. */
export function permissionFrom({
  comments,
  approvals,
}: {
  comments: boolean
  approvals: boolean
}): SharePermission {
  if (approvals) return 'approve'
  return comments ? 'comment' : 'view'
}

/** The two switches a stored permission shows. */
export function togglesFrom(permission: SharePermission): { comments: boolean; approvals: boolean } {
  return {
    comments: permission !== 'view',
    approvals: permission === 'approve',
  }
}

/**
 * What to write when Comments is switched. Off is `view`, which also turns
 * approvals off. On is `comment`, never `approve`: the switch was off, so
 * approvals were off, and it must not bring them back unasked.
 */
export function permissionForComments(on: boolean): SharePermission {
  return permissionFrom({ comments: on, approvals: false })
}

/** What to write when Approvals is switched. On is `approve`, which also turns comments on. Off keeps comments, `comment`. */
export function permissionForApprovals(on: boolean): SharePermission {
  return permissionFrom({ comments: true, approvals: on })
}
