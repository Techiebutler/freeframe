import path from 'node:path'

/** Absolute path of the `e2e/` package. */
export const E2E_ROOT = path.resolve(__dirname, '..')

/** Where `accounts.ts` caches the two accounts. Gitignored: it holds passwords. */
export const ACCOUNTS_FILE = path.join(E2E_ROOT, '.accounts.json')

/** Saved browser sessions, one `<account>.json` each. Gitignored: they hold tokens. */
export const AUTH_DIR = path.join(E2E_ROOT, '.auth')

/** Base URL of the FreeFrame API, from `E2E_API_URL`. */
export function apiUrl(): string {
  return (process.env.E2E_API_URL ?? 'http://localhost:8000').replace(/\/+$/, '')
}

/** Base URL of the web app, from `E2E_BASE_URL`. */
export function baseUrl(): string {
  return (process.env.E2E_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '')
}

/** The saved session of an account: `.auth/<local part of its email>.json`. */
export function authFile(account: { email: string }): string {
  return path.join(AUTH_DIR, `${account.email.split('@')[0]}.json`)
}
