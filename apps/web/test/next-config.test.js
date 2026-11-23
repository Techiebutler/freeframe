import { expect, it } from 'vitest'
import nextConfig from '../next.config.js'

it('disables the Next.js X-Powered-By header', () => {
  expect(nextConfig.poweredByHeader).toBe(false)
})
