/** The project view opened on a folder, or on its root for `null`. The project
 *  page reads `?folder=` to decide which folder it shows. */
export function projectFolderHref(projectId: string, folderId: string | null | undefined): string {
  return folderId ? `/projects/${projectId}?folder=${folderId}` : `/projects/${projectId}`
}
