import type { Project, User } from '@/types'
/** UI visibility only; each management API also checks the selected project. */
// "View as editor": an owner or admin sees the app exactly as an editor does (Alan, 2026-11-08: to demo and check
// what editors get). Display only - every API still checks the real rights. Kept per browser in localStorage.
const VIEW_AS_EDITOR = 'ff:view-as-editor'
export function viewingAsEditor(): boolean {
  try { return typeof window !== 'undefined' && window.localStorage.getItem(VIEW_AS_EDITOR) === '1' } catch { return false }
}
export function setViewingAsEditor(on: boolean) {
  try { if (on) window.localStorage.setItem(VIEW_AS_EDITOR, '1'); else window.localStorage.removeItem(VIEW_AS_EDITOR) } catch { /* private mode: nothing to keep */ }
  window.location.assign('/home')
}
/** The real rights, ignoring "View as editor": decides whether the switch is offered at all. */
export function ownsProjectReally(user: User | null, project: Project) {
  return !!user && (user.is_superadmin || project.role === 'owner' || project.created_by === user.id)
}
export function canManageWorkspaceReally(user: User | null, projects: Project[] = []) {
  return !!user && (user.is_superadmin || projects.some(p => ownsProjectReally(user, p)))
}
export function ownsProject(user: User | null, project: Project) {
  return !viewingAsEditor() && ownsProjectReally(user, project)
}
export function canManageWorkspace(user: User | null, projects: Project[] = []) {
  return !viewingAsEditor() && canManageWorkspaceReally(user, projects)
}
