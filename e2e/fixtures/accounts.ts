import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import { ACCOUNTS_FILE, AUTH_DIR, apiUrl, authFile } from './env'

/**
 * A user of the instance under test. `id` is the user's UUID.
 *
 * The saved browser session of an account lives in `.auth/<local part of the
 * email>.json` (see `authFile`).
 */
export type Account = { email: string; password: string; id: string }

type Accounts = { primary: Account; secondary: Account }

/**
 * The two accounts every scenario uses.
 *
 * Created once, then cached in `e2e/.accounts.json` (gitignored; it holds
 * passwords) and reused by every later run:
 *
 *  - `primary` is the instance's first-run superadmin, created through
 *    `POST /setup/create-superadmin`. That endpoint only works while the
 *    instance has no superadmin, so a stack whose database already holds one
 *    needs `E2E_PRIMARY_EMAIL` and `E2E_PRIMARY_PASSWORD` for an existing
 *    superadmin instead.
 *  - `secondary` is an ordinary member, created by `primary` through
 *    `POST /users/invite` and `POST /auth/accept-invite`. The invite response
 *    carries the token, so no mail has to be read.
 *
 * Whenever the instance reports `needs_setup` the cache is stale (the database
 * was wiped), so it is dropped and both accounts are made again.
 */
export async function primary(): Promise<Account> {
  return (await ensureAccounts()).primary
}

export async function secondary(): Promise<Account> {
  return (await ensureAccounts()).secondary
}

let pending: Promise<Accounts> | null = null

function ensureAccounts(): Promise<Accounts> {
  if (!pending) {
    pending = loadOrCreate().catch((err) => {
      pending = null
      throw err
    })
  }
  return pending
}

async function loadOrCreate(): Promise<Accounts> {
  const status = await json<{ needs_setup: boolean }>('GET', '/setup/status')
  const cached = readCache()
  if (cached && !status.needs_setup) return cached
  if (cached) {
    // The cache names users that no longer exist.
    fs.rmSync(ACCOUNTS_FILE, { force: true })
    fs.rmSync(AUTH_DIR, { recursive: true, force: true })
  }
  const made = await createAccounts(status.needs_setup)
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(made, null, 2), { mode: 0o600 })
  return made
}

function readCache(): Accounts | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8')) as Partial<Accounts>
    const ok = (a?: Account) => !!a && !!a.email && !!a.password && !!a.id
    return ok(parsed.primary) && ok(parsed.secondary) ? (parsed as Accounts) : null
  } catch {
    return null
  }
}

function strongPassword(): string {
  return randomBytes(15).toString('base64url') // 20 chars, well under bcrypt's 72 bytes
}

async function createAccounts(needsSetup: boolean): Promise<Accounts> {
  const tag = randomBytes(3).toString('hex')
  let primaryAccount: Account
  let adminToken: string

  if (needsSetup) {
    const email = `e2e-primary-${tag}@example.com`
    const password = strongPassword()
    const res = await json<{ user_id: string; access_token: string }>('POST', '/setup/create-superadmin', {
      body: { email, name: 'E2E Primary', password },
    })
    primaryAccount = { email, password, id: res.user_id }
    adminToken = res.access_token
  } else {
    const email = process.env.E2E_PRIMARY_EMAIL
    const password = process.env.E2E_PRIMARY_PASSWORD
    if (!email || !password) {
      throw new Error(
        'The instance already has a superadmin, and e2e/.accounts.json has no accounts for it.\n' +
          'Either reset the stack\'s database (docker compose ... down -v) so the first-run setup is available again,\n' +
          'or set E2E_PRIMARY_EMAIL and E2E_PRIMARY_PASSWORD to an existing superadmin.',
      )
    }
    const tokens = await json<{ access_token: string }>('POST', '/auth/login', { body: { email, password } })
    const me = await json<{ id: string }>('GET', '/auth/me', { token: tokens.access_token })
    primaryAccount = { email, password, id: me.id }
    adminToken = tokens.access_token
  }

  const email = `e2e-secondary-${tag}@example.com`
  const password = strongPassword()
  const invited = await json<{ id: string; invite_token: string }>('POST', '/users/invite', {
    token: adminToken,
    body: { email, name: 'E2E Secondary' },
  })
  await json('POST', '/auth/accept-invite', {
    body: { token: invited.invite_token, password, name: 'E2E Secondary' },
  })
  return { primary: primaryAccount, secondary: { email, password, id: invited.id } }
}

// ─── Tokens ────────────────────────────────────────────────────────────────────

const tokenCache = new Map<string, { token: string; at: number }>()
const TOKEN_TTL_MS = 10 * 60 * 1000 // access tokens last 15 minutes

/**
 * A bearer token for API calls made on an account's behalf.
 *
 * Taken from the saved browser session when there is one: its refresh token
 * (valid for days) buys a new access token from `/auth/refresh`, which has a
 * far looser rate limit than `/auth/login` (30 per minute, against 10 per ten).
 * `/auth/login` is the last resort.
 */
export async function accessToken(account: Account): Promise<string> {
  const hit = tokenCache.get(account.email)
  if (hit && Date.now() - hit.at < TOKEN_TTL_MS) return hit.token

  const refresh = savedRefreshToken(account)
  let tokens: { access_token: string } | null = null
  if (refresh) {
    tokens = await json<{ access_token: string }>('POST', '/auth/refresh', {
      body: { refresh_token: refresh },
    }).catch(() => null) // a revoked or expired session falls through to a login
  }
  tokens ??= await json<{ access_token: string }>('POST', '/auth/login', {
    body: { email: account.email, password: account.password },
  })
  tokenCache.set(account.email, { token: tokens.access_token, at: Date.now() })
  return tokens.access_token
}

/** The refresh token in an account's saved browser session, if one exists. */
export function savedRefreshToken(account: Account): string | null {
  try {
    const state = JSON.parse(fs.readFileSync(authFile(account), 'utf8')) as {
      origins?: Array<{ localStorage?: Array<{ name: string; value: string }> }>
    }
    for (const origin of state.origins ?? []) {
      const hit = origin.localStorage?.find((i) => i.name === 'ff_refresh_token')
      if (hit) return hit.value
    }
  } catch {
    /* no saved session */
  }
  return null
}

// ─── HTTP ──────────────────────────────────────────────────────────────────────

/** One JSON request to the API. Throws, naming the status and body, on any non-2xx. */
export async function json<T = unknown>(
  method: string,
  route: string,
  opts: { body?: unknown; token?: string } = {},
): Promise<T> {
  const res = await fetch(`${apiUrl()}${route}`, {
    method,
    headers: {
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`${method} ${route} answered ${res.status}: ${text.slice(0, 300)}`)
  }
  return (text ? JSON.parse(text) : undefined) as T
}
