// @vitest-environment node
import { describe, expect, it } from 'vitest'
import postcss from 'postcss'
import tailwindcss from 'tailwindcss'
import config from '../tailwind.config'

// postcss-selector-parser 6.1.3 broke Tailwind's selector rewriting: with it in
// the tree, every `group-*` and `peer-*` utility compiled to nothing at all, and
// nothing failed -- the build, the type check and every component test passed
// while each hover-revealed control in the app (a comment's resolve check, the
// grid cards' menus, the scrubber thumb) stayed at opacity 0. This compiles real
// class names through the app's own Tailwind config, so a dependency that does
// that again fails here instead of in production.
async function compile(classes: string): Promise<string> {
  const result = await postcss([
    tailwindcss({ ...config, content: [{ raw: `<div class="${classes}"></div>`, extension: 'html' }] }),
  ]).process('@tailwind utilities;', { from: undefined })
  return result.css
}

describe('Tailwind variants that rewrite a parent or sibling selector', () => {
  it('emits group-hover, including a named group', async () => {
    const css = await compile('group-hover:opacity-100 group-hover/comment:opacity-100')
    expect(css).toContain('.group:hover .group-hover\\:opacity-100')
    expect(css).toContain('.group\\/comment:hover .group-hover\\/comment\\:opacity-100')
  })

  it('emits group-hover under an arbitrary media variant', async () => {
    const css = await compile('[@media(hover:hover)]:group-hover:opacity-100')
    expect(css).toMatch(/@media\s*\(hover:\s*hover\)/)
    expect(css).toContain('.group:hover .\\[\\@media\\(hover\\:hover\\)\\]\\:group-hover\\:opacity-100')
  })

  it('emits peer variants', async () => {
    const css = await compile('peer-hover:opacity-100')
    expect(css).toContain('.peer:hover ~ .peer-hover\\:opacity-100')
  })
})
