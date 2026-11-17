// The API's limit on a share-link password, SHARE_PASSWORD_MAX_BYTES in
// apps/api/schemas/share.py. It counts UTF-8 bytes, so an accented letter or an
// emoji takes more than one; `maxLength` on the input counts UTF-16 units and
// would let those through to a save the API refuses.
export const SHARE_PASSWORD_MAX_BYTES = 128

export function sharePasswordTooLong(password: string): boolean {
  return new TextEncoder().encode(password).length > SHARE_PASSWORD_MAX_BYTES
}

export const SHARE_PASSWORD_TOO_LONG =
  `Too long to save: a passphrase can be at most ${SHARE_PASSWORD_MAX_BYTES} bytes ` +
  '(accented letters and emoji count as more than one). Shorten it to save it.'
