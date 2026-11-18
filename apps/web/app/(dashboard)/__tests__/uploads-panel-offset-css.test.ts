// @vitest-environment node
/**
 * The panel's two left offsets have to survive into the compiled CSS.
 *
 * Tailwind emits a rule only for a class it can read whole in a file its
 * `content` globs cover. Both halves of that can break silently and neither is
 * visible from a rendering test: building the class from a template literal
 * produces the identical className at runtime, and a file outside the globs
 * still renders its classes into the DOM. In both cases the element carries a
 * class name that no stylesheet defines, the offset resolves to nothing, and
 * the panel opens on top of the sidebar again -- which is the bug this fix
 * exists for.
 *
 * So this runs the repo's own Tailwind, with the repo's own theme, and asks the
 * output -- which is where the answer actually lives. It also pins the
 * breakpoint, because the 220px offset applying below `md` is its own bug: the
 * panel is a hard 380px and 220 + 380 is wider than a phone.
 *
 * `content` is narrowed to the panel itself rather than left at the repo's
 * globs, and that is not a shortcut. Those globs cover `app/**`, which includes
 * the test files, so the sibling test's own assertion strings are enough to
 * make Tailwind emit both rules -- with the whole project as input this file
 * would pass even for a panel that had stopped asking for them. Narrowed, the
 * question is the right one: does this component, on its own, produce these
 * rules?
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { fileURLToPath } from 'node:url'
import postcss from 'postcss'
import tailwindcss from 'tailwindcss'
import config from '../../../tailwind.config'

const PANEL = fileURLToPath(
  new URL('../../../components/layout/uploads-panel.tsx', import.meta.url),
)

let css = ''

beforeAll(async () => {
  const result = await postcss([
    tailwindcss({ ...config, content: [PANEL] }),
  ]).process('@tailwind utilities;', { from: undefined })
  css = result.css
}, 60_000)

/**
 * Every media context a rule for this offset is emitted in: the string for a
 * rule inside an at-rule, and null for an unconditional one. Empty means
 * Tailwind emitted nothing at all, which is the failure this file exists to
 * catch. Matched on the declaration's own text rather than the escaped
 * selector, since the selector carries a backslash before every bracket.
 */
function mediaContexts(offset: string): (string | null)[] {
  const found: (string | null)[] = []
  postcss.parse(css).walkDecls('--ff-left', (decl) => {
    // postcss keeps `!important` as a flag rather than in the value, so an
    // `![--ff-left:52px]` base compiles to an unconditional rule the `md:` one
    // can never win against: the panel would sit at 52px over an expanded rail
    // at every width with all five of these green. A declaration that cannot
    // be overridden is not the offset this file is asserting.
    if (decl.important) return
    if (decl.value.trim() !== offset) return
    const rule = decl.parent
    const parent = rule?.parent
    found.push(parent && parent.type === 'atrule' ? `@${parent.name} ${parent.params}` : null)
  })
  return found
}

describe('the uploads panel offsets in the compiled CSS', () => {
  it('emits the collapsed offset, and at every width', () => {
    expect(mediaContexts('52px')).toContain(null)
  })

  it('emits the expanded offset, and only from md up', () => {
    const contexts = mediaContexts('220px')

    expect(contexts).toContain('@media (min-width: 768px)')
    // The one that would hurt: an unconditional 220px rule puts the panel
    // 220px from the left on a phone too, which is what `md:` is preventing.
    expect(contexts).not.toContain(null)
  })
})
