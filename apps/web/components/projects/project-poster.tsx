import { cn } from '@/lib/utils'
import { getGradientForProject } from '@/lib/gradient-utils'
import type { Project } from '@/types'

/**
 * A project's picture: the poster someone chose, or else the gradient the
 * project's id picks. The card and the list row both show it, so a project
 * looks the same in either view. Fills its container, which sets the size,
 * the shape and `relative`.
 */
export function ProjectPoster({ project, className }: { project: Pick<Project, 'id' | 'name' | 'poster_url'>; className?: string }) {
  if (project.poster_url) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={project.poster_url}
        alt={project.name}
        className={cn('h-full w-full object-cover', className)}
      />
    )
  }
  return (
    <div
      data-project-poster={project.id}
      className={cn('h-full w-full bg-gradient-to-br', getGradientForProject(project.id), className)}
    >
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_40%,rgba(255,255,255,0.1),transparent_60%)]" />
    </div>
  )
}
