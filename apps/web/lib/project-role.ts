/**
 * The role a screen should act on for one project.
 *
 * An account with the Admin role on this instance reaches every live project
 * with owner rights, member or not: the server answers its gates with a
 * stand-in owner membership and writes an `admin_project_access` row.
 *
 * `role` is deliberately not that answer. It says what the caller's own
 * membership is, so the member list, the member count and the project's emails
 * keep saying the admin is not a member, and `GET /projects?scope=all` leaves
 * it null for a project the admin is not in. A screen that reads `role` alone
 * therefore offers a non-member admin viewer controls, or refuses a settings
 * page the server would accept every save on.
 *
 * One helper and one signal (`isSuperAdmin`, off `GET /auth/me`), so no screen
 * has to infer it from `role` again. `role` is taken and returned as the API
 * types it, a plain string, so a caller comparing against a tier is unchanged.
 */
export function effectiveProjectRole(
  role: string | null | undefined,
  isSuperAdmin: boolean,
): string | null {
  if (isSuperAdmin) return 'owner'
  return role ?? null
}
