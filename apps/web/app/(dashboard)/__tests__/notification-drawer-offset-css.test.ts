// @vitest-environment node
import { beforeAll, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import postcss from 'postcss'
import tailwindcss from 'tailwindcss'
import config from '../../../tailwind.config'

const DRAWER = fileURLToPath(
  new URL('../../../components/layout/notification-drawer.tsx', import.meta.url),
)

let css = ''

beforeAll(async () => {
  const result = await postcss([
    tailwindcss({ ...config, content: [DRAWER] }),
  ]).process('@tailwind utilities;', { from: undefined })
  css = result.css
}, 60_000)

function mediaContexts(property: string, offset: string): (string | null)[] {
  const found: (string | null)[] = []
  postcss.parse(css).walkDecls(property, (decl) => {
    if (decl.important || decl.value.trim() !== offset) return
    const parent = decl.parent?.parent
    found.push(parent?.type === 'atrule' ? `@${parent.name} ${parent.params}` : null)
  })
  return found
}

describe('the notification drawer offsets in compiled CSS', () => {
  it('emits both collapsed offsets unconditionally', () => {
    expect(mediaContexts('--ff-left', '52px')).toContain(null)
    expect(mediaContexts('left', '52px')).toContain(null)
  })

  it('emits both expanded offsets only from md up', () => {
    for (const property of ['--ff-left', 'left']) {
      const contexts = mediaContexts(property, '220px')
      expect(contexts).toContain('@media (min-width: 768px)')
      expect(contexts).not.toContain(null)
    }
  })
})
