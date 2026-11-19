import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SWRConfig } from 'swr'
import { VerdictControls, VERDICT_ROW_CLASS } from '../verdict-controls'
import { ApiError } from '@/lib/api'
import type { ProjectRole, Verdict } from '@/types'

const { api } = vi.hoisted(() => ({
  api: { get: vi.fn(), put: vi.fn(), delete: vi.fn() },
}))

// The real ApiError stays, so a rejected call carries its `detail` as it does in the app.
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api,
}))

const KEY_V1 = '/assets/a1/verdicts?version_id=v1'
const KEY_V2 = '/assets/a1/verdicts?version_id=v2'

function makeVerdict(partial: Partial<Verdict> & { id: string }): Verdict {
  return {
    version_id: 'v1',
    status: 'approved',
    note: null,
    created_at: '2026-11-18T10:00:00Z',
    updated_at: '2026-11-18T10:00:00Z',
    who: { kind: 'team', name: 'Priya', avatar_url: null, avatar_color: null, is_guest: false },
    via_link_title: null,
    is_mine: false,
    ...partial,
  }
}

const dana = makeVerdict({
  id: 'd1',
  status: 'changes_requested',
  note: 'Logo is too small',
  who: { kind: 'external', name: 'Dana', avatar_url: null, avatar_color: null, is_guest: true },
  via_link_title: 'Client review',
})
const myApproval = makeVerdict({ id: 'm1', status: 'approved', is_mine: true })
const myChanges = makeVerdict({ id: 'm2', status: 'changes_requested', note: 'Fix it', is_mine: true })

/** What GET answers, by path. Anything not listed has no verdicts. */
let served: Record<string, Verdict[]>

beforeEach(() => {
  vi.clearAllMocks()
  served = {}
  api.get.mockImplementation(async (path: string) => served[path] ?? [])
  api.put.mockResolvedValue({})
  api.delete.mockResolvedValue(undefined)
})

type Props = React.ComponentProps<typeof VerdictControls>

/** A fresh SWR cache per test, so a key one test filled cannot answer the next. */
function ui(props: Partial<Props> = {}) {
  return (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>
      <VerdictControls assetId="a1" versionId="v1" role="reviewer" {...props} />
    </SWRConfig>
  )
}

function renderControls(props: Partial<Props> = {}) {
  return render(ui(props))
}

/** Exact names: the indicator's own trigger reads like "1 verdict, changes needed". */
const button = (name: string) => screen.getByRole('button', { name })

describe('VerdictControls', () => {
  describe('who gets buttons', () => {
    it.each<ProjectRole | null>(['viewer', null])('shows a %s the indicator and no buttons', async (role) => {
      served[KEY_V1] = [dana]
      renderControls({ role })

      expect(await screen.findByRole('button', { name: '1 verdict, changes needed' })).toBeInTheDocument()
      for (const name of ['Approve', 'Changes needed', 'Reject']) {
        expect(screen.queryByRole('button', { name })).not.toBeInTheDocument()
      }
    })

    it.each<ProjectRole>(['reviewer', 'editor', 'owner'])('gives a %s all three buttons', (role) => {
      renderControls({ role })

      for (const name of ['Approve', 'Changes needed', 'Reject']) {
        expect(button(name)).toBeEnabled()
      }
    })
  })

  describe('giving a verdict', () => {
    it('sends Approve straight away, with no note box', async () => {
      const user = userEvent.setup()
      renderControls()

      await user.click(button('Approve'))

      expect(api.put).toHaveBeenCalledTimes(1)
      expect(api.put).toHaveBeenCalledWith('/assets/a1/verdict', { version_id: 'v1', status: 'approved' })
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    })

    it('asks for an optional note before sending Changes needed, and sends it', async () => {
      const user = userEvent.setup()
      renderControls()

      await user.click(button('Changes needed'))
      expect(api.put).not.toHaveBeenCalled()

      await user.type(screen.getByRole('textbox', { name: 'Note (optional)' }), 'logo too small')
      await user.click(button('Send'))

      expect(api.put).toHaveBeenCalledTimes(1)
      expect(api.put).toHaveBeenCalledWith('/assets/a1/verdict', {
        version_id: 'v1',
        status: 'changes_requested',
        note: 'logo too small',
      })
      // Done: the box is put away.
      await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument())
    })

    it('sends Reject with no note at all when the box is left empty', async () => {
      const user = userEvent.setup()
      renderControls()

      await user.click(button('Reject'))
      await user.click(button('Send'))

      expect(api.put).toHaveBeenCalledWith('/assets/a1/verdict', { version_id: 'v1', status: 'rejected' })
    })

    it('does not send a note that is only space', async () => {
      const user = userEvent.setup()
      renderControls()

      await user.click(button('Reject'))
      await user.type(screen.getByRole('textbox'), '   ')
      await user.click(button('Send'))

      expect(api.put).toHaveBeenCalledWith('/assets/a1/verdict', { version_id: 'v1', status: 'rejected' })
    })

    it('puts the note box away on Cancel and on Escape, sending nothing', async () => {
      const user = userEvent.setup()
      renderControls()

      await user.click(button('Reject'))
      await user.click(button('Cancel'))
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument()

      await user.click(button('Changes needed'))
      expect(screen.getByRole('textbox')).toBeInTheDocument()
      await user.keyboard('{Escape}')
      await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument())

      expect(api.put).not.toHaveBeenCalled()
    })

    it('puts the note box away when the same button is pressed again', async () => {
      const user = userEvent.setup()
      renderControls()

      await user.click(button('Reject'))
      expect(screen.getByRole('textbox')).toBeInTheDocument()
      await user.click(button('Reject'))

      await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument())
      expect(api.put).not.toHaveBeenCalled()
    })

    it('swaps the note box for the other verdict\'s, without carrying the note over', async () => {
      const user = userEvent.setup()
      renderControls()

      await user.click(button('Changes needed'))
      await user.type(screen.getByRole('textbox'), 'meant for the other one')
      await user.click(button('Reject'))

      expect(screen.getByRole('textbox')).toHaveValue('')
      await user.click(button('Send'))
      expect(api.put).toHaveBeenCalledWith('/assets/a1/verdict', { version_id: 'v1', status: 'rejected' })
    })

    it('closes the note box when Approve is pressed, and approves', async () => {
      const user = userEvent.setup()
      renderControls()

      await user.click(button('Reject'))
      await user.click(button('Approve'))

      expect(api.put).toHaveBeenCalledWith('/assets/a1/verdict', { version_id: 'v1', status: 'approved' })
      await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument())
    })

    it('keeps the note at 16px on a touch screen, so iOS Safari does not zoom in on focus', async () => {
      const user = userEvent.setup()
      renderControls()

      // Radix focuses the box as it opens, and iOS zooms into any field under 16px.
      await user.click(button('Reject'))

      const classes = screen.getByRole('textbox').className.split(/\s+/)
      expect(classes).toContain('text-[16px]')
      // Mice get the compact size, as the comment composer does.
      expect(classes).toContain('[@media(hover:hover)]:text-[13px]')
      expect(classes).not.toContain('text-sm')
    })

    it('limits the note to what the API accepts', async () => {
      const user = userEvent.setup()
      renderControls()

      await user.click(button('Reject'))

      expect(screen.getByRole('textbox')).toHaveAttribute('maxlength', '5000')
    })

    it('changes the verdict when another button is pressed while one is held', async () => {
      served[KEY_V1] = [myApproval]
      const user = userEvent.setup()
      renderControls()
      await waitFor(() => expect(button('Approve')).toHaveAttribute('aria-pressed', 'true'))

      await user.click(button('Reject'))
      await user.click(button('Send'))

      expect(api.put).toHaveBeenCalledWith('/assets/a1/verdict', { version_id: 'v1', status: 'rejected' })
      expect(api.delete).not.toHaveBeenCalled()
    })
  })

  describe('the pressed button', () => {
    it('marks the caller\'s own verdict as pressed and the rest as not', async () => {
      served[KEY_V1] = [dana, myChanges]
      renderControls()

      await waitFor(() => expect(button('Changes needed')).toHaveAttribute('aria-pressed', 'true'))
      expect(button('Approve')).toHaveAttribute('aria-pressed', 'false')
      expect(button('Reject')).toHaveAttribute('aria-pressed', 'false')
    })

    it('presses nothing for someone else\'s verdict', async () => {
      served[KEY_V1] = [dana]
      renderControls()

      await screen.findByRole('button', { name: '1 verdict, changes needed' })
      for (const name of ['Approve', 'Changes needed', 'Reject']) {
        expect(button(name)).toHaveAttribute('aria-pressed', 'false')
      }
    })

    it('clears the verdict when the pressed Approve is pressed again', async () => {
      served[KEY_V1] = [myApproval]
      const user = userEvent.setup()
      renderControls()
      await waitFor(() => expect(button('Approve')).toHaveAttribute('aria-pressed', 'true'))

      await user.click(button('Approve'))

      expect(api.delete).toHaveBeenCalledTimes(1)
      expect(api.delete).toHaveBeenCalledWith('/assets/a1/verdict?version_id=v1')
      expect(api.put).not.toHaveBeenCalled()
    })

    it('clears a held Changes needed at once, without the note box', async () => {
      served[KEY_V1] = [myChanges]
      const user = userEvent.setup()
      renderControls()
      await waitFor(() => expect(button('Changes needed')).toHaveAttribute('aria-pressed', 'true'))

      await user.click(button('Changes needed'))

      expect(api.delete).toHaveBeenCalledWith('/assets/a1/verdict?version_id=v1')
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    })

    it('shows the new state once the server has answered', async () => {
      const user = userEvent.setup()
      renderControls()
      await waitFor(() => expect(api.get).toHaveBeenCalledTimes(1))

      // The server now holds the caller's approval.
      served[KEY_V1] = [myApproval]
      await user.click(button('Approve'))

      await waitFor(() => expect(button('Approve')).toHaveAttribute('aria-pressed', 'true'))
      expect(api.get).toHaveBeenCalledTimes(2)
    })
  })

  describe('while a request is in flight', () => {
    it('disables every button and sends nothing twice', async () => {
      let finish!: () => void
      api.put.mockReturnValue(new Promise<void>((resolve) => (finish = resolve)))
      const user = userEvent.setup()
      renderControls()

      await user.click(button('Approve'))
      for (const name of ['Approve', 'Changes needed', 'Reject']) expect(button(name)).toBeDisabled()

      await user.click(button('Approve'))
      expect(api.put).toHaveBeenCalledTimes(1)

      finish()
      await waitFor(() => expect(button('Approve')).toBeEnabled())
      expect(api.put).toHaveBeenCalledTimes(1)
    })

    it('starts no removal either, since the indicator\'s Remove is not one of the buttons', async () => {
      served[KEY_V1] = [dana]
      let finish!: () => void
      api.put.mockReturnValue(new Promise<void>((resolve) => (finish = resolve)))
      const user = userEvent.setup()
      renderControls({ role: 'editor' })

      await user.click(button('Approve'))
      await user.click(await screen.findByRole('button', { name: /^\d+ verdicts?, / }))
      await user.click(screen.getByRole('button', { name: 'Remove' }))
      await user.click(within(screen.getByRole('group', { name: "Remove Dana's verdict" })).getByRole('button', { name: 'Remove' }))

      expect(api.delete).not.toHaveBeenCalled()
      finish()
      await waitFor(() => expect(button('Approve')).toBeEnabled())
    })

    it('locks the note box too, so Send cannot be pressed twice', async () => {
      let finish!: () => void
      api.put.mockReturnValue(new Promise<void>((resolve) => (finish = resolve)))
      const user = userEvent.setup()
      renderControls()

      await user.click(button('Reject'))
      await user.click(button('Send'))
      expect(button('Sending…')).toBeDisabled()
      await user.click(button('Sending…'))
      expect(api.put).toHaveBeenCalledTimes(1)

      finish()
      await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument())
    })
  })

  describe('when a call fails', () => {
    it('shows the server\'s detail inline and lets the reviewer try again', async () => {
      api.put.mockRejectedValueOnce(new ApiError(403, "Your project role can't give verdicts"))
      const user = userEvent.setup()
      renderControls()

      await user.click(button('Approve'))

      expect(await screen.findByRole('alert')).toHaveTextContent("Your project role can't give verdicts")
      expect(button('Approve')).toBeEnabled()

      await user.click(button('Approve'))
      expect(api.put).toHaveBeenCalledTimes(2)
      await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
    })

    it('keeps the note box and what was typed when sending a note fails', async () => {
      api.put.mockRejectedValueOnce(new ApiError(404, 'Version not found'))
      const user = userEvent.setup()
      renderControls()

      await user.click(button('Changes needed'))
      await user.type(screen.getByRole('textbox'), 'logo too small')
      await user.click(button('Send'))

      expect(await screen.findByRole('alert')).toHaveTextContent('Version not found')
      expect(screen.getByRole('textbox')).toHaveValue('logo too small')
      expect(button('Send')).toBeEnabled()
    })

    it('falls back to a plain sentence when the failure carries no detail', async () => {
      api.put.mockRejectedValueOnce(new TypeError('Failed to fetch'))
      const user = userEvent.setup()
      renderControls()

      await user.click(button('Approve'))

      expect(await screen.findByRole('alert')).toHaveTextContent(/couldn.t save/i)
    })

    it('shows the detail when clearing fails', async () => {
      served[KEY_V1] = [myApproval]
      api.delete.mockRejectedValueOnce(new ApiError(404, 'Version not found'))
      const user = userEvent.setup()
      renderControls()
      await waitFor(() => expect(button('Approve')).toHaveAttribute('aria-pressed', 'true'))

      await user.click(button('Approve'))

      expect(await screen.findByRole('alert')).toHaveTextContent('Version not found')
    })
  })

  describe('removing someone else\'s verdict', () => {
    async function openIndicator(user: ReturnType<typeof userEvent.setup>) {
      await user.click(await screen.findByRole('button', { name: /^\d+ verdicts?, / }))
    }

    it('lets an editor remove it, after one confirmation', async () => {
      served[KEY_V1] = [dana]
      const user = userEvent.setup()
      renderControls({ role: 'editor' })
      await openIndicator(user)

      await user.click(screen.getByRole('button', { name: 'Remove' }))
      expect(api.delete).not.toHaveBeenCalled()
      const confirm = screen.getByRole('group', { name: "Remove Dana's verdict" })
      await user.click(within(confirm).getByRole('button', { name: 'Remove' }))

      expect(api.delete).toHaveBeenCalledTimes(1)
      expect(api.delete).toHaveBeenCalledWith('/assets/a1/verdicts/d1')
    })

    it('lets an owner remove it too', async () => {
      served[KEY_V1] = [dana]
      renderControls({ role: 'owner' })
      await openIndicator(userEvent.setup())

      expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument()
    })

    it('offers a reviewer no Remove', async () => {
      served[KEY_V1] = [dana]
      renderControls({ role: 'reviewer' })
      await openIndicator(userEvent.setup())

      expect(screen.getByText('Dana')).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument()
    })

    it('shows the detail when removing fails', async () => {
      served[KEY_V1] = [dana]
      api.delete.mockRejectedValueOnce(new ApiError(403, 'Only owners and editors can remove verdicts'))
      const user = userEvent.setup()
      renderControls({ role: 'editor' })
      await openIndicator(user)
      await user.click(screen.getByRole('button', { name: 'Remove' }))

      await user.click(within(screen.getByRole('group', { name: "Remove Dana's verdict" })).getByRole('button', { name: 'Remove' }))

      expect(await screen.findByRole('alert')).toHaveTextContent('Only owners and editors can remove verdicts')
    })

    it('refreshes the list after a removal', async () => {
      served[KEY_V1] = [dana]
      const user = userEvent.setup()
      renderControls({ role: 'editor' })
      await openIndicator(user)
      await user.click(screen.getByRole('button', { name: 'Remove' }))

      served[KEY_V1] = []
      await user.click(within(screen.getByRole('group', { name: "Remove Dana's verdict" })).getByRole('button', { name: 'Remove' }))

      await waitFor(() => expect(screen.queryByRole('button', { name: /^\d+ verdicts?, / })).not.toBeInTheDocument())
    })
  })

  describe('switching version', () => {
    it('reads the verdicts of the version it is given, and refetches for the next', async () => {
      served[KEY_V1] = [dana]
      served[KEY_V2] = [myApproval, makeVerdict({ id: 'x', status: 'approved' })]
      const { rerender } = renderControls({ versionId: 'v1' })
      expect(await screen.findByRole('button', { name: '1 verdict, changes needed' })).toBeInTheDocument()
      expect(api.get).toHaveBeenCalledWith(KEY_V1)

      rerender(ui({ versionId: 'v2' }))

      expect(await screen.findByRole('button', { name: '2 verdicts, approved' })).toBeInTheDocument()
      expect(api.get).toHaveBeenCalledWith(KEY_V2)
      expect(button('Approve')).toHaveAttribute('aria-pressed', 'true')
    })

    it('sends the new version with a verdict given after the switch', async () => {
      const user = userEvent.setup()
      const { rerender } = renderControls({ versionId: 'v1' })

      rerender(ui({ versionId: 'v2' }))
      await user.click(button('Approve'))

      expect(api.put).toHaveBeenCalledWith('/assets/a1/verdict', { version_id: 'v2', status: 'approved' })
    })

    it('drops a half-written note when the version changes', async () => {
      const user = userEvent.setup()
      const { rerender } = renderControls({ versionId: 'v1' })
      await user.click(button('Reject'))
      await user.type(screen.getByRole('textbox'), 'not this one')

      rerender(ui({ versionId: 'v2' }))

      await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument())
    })
  })

  describe('the phone row', () => {
    it('says so when a viewer has nothing to look at yet', async () => {
      renderControls({ role: 'viewer', variant: 'row' })

      expect(await screen.findByText('No verdicts yet')).toBeInTheDocument()
    })

    it('says nothing of the kind on the top bar, or to someone with buttons', async () => {
      const { unmount } = renderControls({ role: 'viewer', variant: 'toolbar' })
      await waitFor(() => expect(api.get).toHaveBeenCalled())
      expect(screen.queryByText('No verdicts yet')).not.toBeInTheDocument()
      unmount()

      renderControls({ role: 'reviewer', variant: 'row' })
      await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2))
      expect(screen.queryByText('No verdicts yet')).not.toBeInTheDocument()
    })

    it('writes the labels out, which the top bar leaves to the icons', () => {
      const { unmount } = renderControls({ variant: 'row' })
      expect(button('Changes needed')).toHaveTextContent('Changes needed')
      unmount()

      renderControls({ variant: 'toolbar' })
      // Still named for assistive tech and as a tooltip, with no words in the bar.
      expect(button('Changes needed').textContent).toBe('')
      expect(button('Changes needed')).toHaveAttribute('title', 'Changes needed')
    })

    // jsdom has no layout, so a container query cannot be run here: these pin
    // the classes that carry it, and the real widths were measured in a browser.
    describe('when the row has no room for words', () => {
      const NARROW = '[@container(max-width:380px)]'

      it('hides each label by the row\'s own width, and squares the button, without renaming it', async () => {
        served[KEY_V1] = [myApproval]
        renderControls({ variant: 'row' })
        await waitFor(() => expect(button('Approve')).toHaveAttribute('aria-pressed', 'true'))

        for (const name of ['Approve', 'Changes needed', 'Reject']) {
          const btn = button(name)
          // The label is still in the tree, so the name does not depend on it.
          const label = within(btn).getByText(name)
          expect(label).toHaveClass(`${NARROW}:hidden`)
          expect(btn).toHaveAccessibleName(name)
          expect(btn).toHaveAttribute('title', name)
          // At least 32px tall always, and 32px wide once the label is gone.
          expect(btn).toHaveClass('h-8', `${NARROW}:w-8`, `${NARROW}:px-0`)
        }
      })

      it('keeps what is pressed, pressed', async () => {
        served[KEY_V1] = [myChanges]
        renderControls({ variant: 'row' })

        await waitFor(() => expect(button('Changes needed')).toHaveAttribute('aria-pressed', 'true'))
        expect(button('Approve')).toHaveAttribute('aria-pressed', 'false')
        expect(button('Reject')).toHaveAttribute('aria-pressed', 'false')
      })

      it('puts nothing for the query on the top bar, which is icons already', () => {
        renderControls({ variant: 'toolbar' })

        for (const name of ['Approve', 'Changes needed', 'Reject']) {
          expect(button(name).className).not.toContain('@container')
        }
      })

      it('is asked of the row, which is a size container and keeps its one fixed height', () => {
        const classes = VERDICT_ROW_CLASS.split(/\s+/)

        expect(classes).toContain('[container-type:inline-size]')
        expect(classes).toContain('h-10')
        expect(classes).toContain('shrink-0')
      })
    })
  })
})
