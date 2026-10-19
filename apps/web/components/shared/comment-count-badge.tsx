import { MessageSquare } from 'lucide-react'

/**
 * A thumbnail's comment count, bottom-left: the same badge in the project grid
 * and in a share link's grid. Nothing when there are no comments.
 */
export function CommentCountBadge({ count }: { count?: number | null }) {
  if (!count || count <= 0) return null
  return (
    <div
      className="absolute bottom-2 left-2 flex items-center gap-1 bg-bg-primary/80 backdrop-blur-sm rounded-md px-1.5 py-0.5"
      title={`${count} comment${count === 1 ? '' : 's'}`}
    >
      <MessageSquare className="h-3 w-3 text-text-primary" />
      <span className="text-[10px] font-medium text-text-primary tabular-nums">{count}</span>
    </div>
  )
}
