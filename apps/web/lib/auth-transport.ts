export const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'
export const HOST_REFRESH_COOKIE = '__Host-ff_refresh_token'
export const LEGACY_REFRESH_COOKIE = 'ff_refresh_token'

export function usesRefreshCookie(): boolean {
  if (typeof window === 'undefined' || window.location.protocol !== 'https:') return false
  const { origin } = window.location
  return new URL(API_URL, origin).origin === origin
}

export function webClientHeaders(): Record<string, string> {
  return usesRefreshCookie() ? { 'X-FF-Client': 'web' } : {}
}
