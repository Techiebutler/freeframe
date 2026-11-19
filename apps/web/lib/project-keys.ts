/**
 * Matches the SWR keys of the project list: `/projects` and the same path with
 * a query string (`/projects?scope=all`). Not a project's own keys such as
 * `/projects/p1` or `/projects/p1/assets`, so a revalidation by this matcher
 * leaves every asset, member and folder list alone.
 */
export const isProjectListKey = (key: unknown): boolean =>
  typeof key === 'string' && (key === '/projects' || key.startsWith('/projects?'))
