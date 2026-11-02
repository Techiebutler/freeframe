import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render as rtlRender, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { SWRConfig } from 'swr'

const get = vi.fn()
const del = vi.fn()
const post = vi.fn()
vi.mock('@/lib/api', () => ({
  api: {
    get: (...a: unknown[]) => get(...a),
    delete: (...a: unknown[]) => del(...a),
    post: (...a: unknown[]) => post(...a),
  },
}))

import { StorageTab } from '../storage-tab'
import { FULL_BIN, GB, MB, files, overview, summary, trash } from './admin-fixtures'
import type { StorageOverview, StorageProjectFiles, TrashOverview } from '@/types'

/**
 * What takes up the instance's storage, and the two ways to get it back.
 *
 * Both dangerous actions are gated here and again on the server; these cases
 * are about the dialog asking first and about one request per action, never
 * about the dialog being the only check.
 */

/** A fresh SWR cache per test, so one test's overview is not another's. */
function render(ui: React.ReactElement) {
  return rtlRender(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{ui}</SWRConfig>,
  )
}

/** Route the component's GETs to whatever a test wants back. */
function serve({
  storage = overview(),
  project = files(),
  bin = trash(),
}: {
  storage?: StorageOverview | Error
  project?: StorageProjectFiles | Error
  bin?: TrashOverview
} = {}) {
  get.mockImplementation((path: string) => {
    if (path === '/admin/storage') {
      return storage instanceof Error ? Promise.reject(storage) : Promise.resolve(storage)
    }
    if (path === '/admin/trash') return Promise.resolve(bin)
    if (path.startsWith('/admin/storage/projects/')) {
      return project instanceof Error ? Promise.reject(project) : Promise.resolve(project)
    }
    return Promise.reject(new Error(`unexpected GET ${path}`))
  })
}

async function pick(...names: string[]) {
  for (const name of names) {
    fireEvent.click(await screen.findByRole('checkbox', { name: `Select ${name}` }))
  }
}

async function openTrash() {
  fireEvent.click(await screen.findByRole('button', { name: 'trash' }))
}

async function type(value: string) {
  fireEvent.change(await screen.findByLabelText(/type DELETE/i), { target: { value } })
}

beforeEach(() => {
  get.mockReset()
  del.mockReset()
  post.mockReset()
  post.mockResolvedValue({})
})

// ── the one line above the list ───────────────────────────────────────────────

describe('the header line', () => {
  // Without a configured limit there is no capacity this app can learn, and
  // inventing a denominator would reassure somebody whose disk is nearly full.
  // "Of which" went twice around: it was wrong while used excluded the trash, so
  // it became "Plus". Used now counts the trash, because the upload limit does and
  // a header promising space the next upload is refused for is the worse error.
  it.each([
    { what: 'no limit', partial: {}, says: /400 MB used/, hides: /free/ },
    {
      what: 'a limit',
      partial: { capacity_bytes: 1000 * MB, free_bytes: 600 * MB },
      says: /400 MB of 1000 MB used/,
      hides: null,
    },
  ])('says what is used, and capacity only with $what', async ({ partial, says, hides }) => {
    serve({ storage: overview({ summary: summary({ trash_bytes: 90 * MB, ...partial }) }) })
    render(<StorageTab />)
    expect(await screen.findByText(says)).toBeInTheDocument()
    if (hides) expect(screen.queryByText(hides)).not.toBeInTheDocument()
    else expect(screen.getByText(/600 MB free/)).toBeInTheDocument()
    expect(screen.getByText(/Of which 90 MB is in the/)).toBeInTheDocument()
    expect(screen.getByText(/gone for good after 30 days/)).toBeInTheDocument()
    expect(screen.queryByText(/^Plus /)).not.toBeInTheDocument()

    // None of the figures the target picture dropped are back on the page.
    for (const gone of [/original/i, /derived/i, /Projects by size/i, /Instance storage/i]) {
      expect(screen.queryByText(gone)).not.toBeInTheDocument()
    }
    expect(screen.queryByRole('button', { name: /measure now/i })).not.toBeInTheDocument()
  })
})

// ── the list ──────────────────────────────────────────────────────────────────

describe('the project list', () => {
  // A 500 used to fall through to the empty state, so an instance with a full
  // disk was told it held no media at all.
  it.each([
    { what: 'a refusal', storage: new Error('Internal Server Error'), says: 'Internal Server Error', hides: /Nothing stored yet/ },
    { what: 'an empty instance', storage: overview({ projects: [], project_count: 0 }), says: /nothing stored yet/i, hides: null },
    { what: 'a truncated list', storage: overview({ project_count: 412 }), says: /showing the 2 largest of 412 projects/i, hides: null },
  ])('says which state it is in: $what', async ({ storage, says, hides }) => {
    serve({ storage })
    render(<StorageTab />)
    expect(await screen.findByText(says)).toBeInTheDocument()
    if (hides) expect(screen.queryByText(hides)).not.toBeInTheDocument()
  })

  it('expands a project to its files and versions, fetching only the one opened', async () => {
    serve()
    render(<StorageTab />)

    // No Select all: forty projects take forty deliberate clicks.
    expect(await screen.findByText('Big Campaign')).toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: /select all/i })).not.toBeInTheDocument()
    fireEvent.click(await screen.findByRole('button', { expanded: false, name: /Big Campaign/ }))
    expect(await screen.findByText('Hero Cut.mov')).toBeInTheDocument()
    expect(get).toHaveBeenCalledWith('/admin/storage/projects/p-big')
    expect(get).not.toHaveBeenCalledWith('/admin/storage/projects/p-small')
    fireEvent.click(await screen.findByRole('button', { expanded: false, name: /Hero Cut/ }))
    expect(await screen.findByText(/Version 3/)).toBeInTheDocument()
    expect(screen.getByText(/Version 1/)).toBeInTheDocument()
  })

  it('shows why a project could not be expanded', async () => {
    serve({ project: new Error('Project not found') })
    render(<StorageTab />)
    fireEvent.click(await screen.findByRole('button', { expanded: false, name: /Big Campaign/ }))
    expect(await screen.findByText('Project not found')).toBeInTheDocument()
  })
})

// ── deleting, and its gate ────────────────────────────────────────────────────

describe('the delete gate', () => {
  it('one project needs one click and no phrase, and says where it goes', async () => {
    serve()
    render(<StorageTab />)
    await screen.findByText('Big Campaign')

    // Nothing to press until something is picked.
    expect(screen.queryByRole('button', { name: /^Delete/ })).not.toBeInTheDocument()
    await pick('Big Campaign')

    // The count and the size, both in the button label.
    expect(screen.getByRole('button', { name: 'Delete 1 (320 MB)' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Delete 1/ }))
    expect(await screen.findByText('Delete 1 item?')).toBeInTheDocument()
    expect(screen.queryByLabelText(/type DELETE/i)).not.toBeInTheDocument()
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText(/go to the trash for 30 days/)).toBeInTheDocument()
    expect(within(dialog).getByText(/loses access right away/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        '/admin/delete',
        expect.objectContaining({
          project_ids: ['p-big'],
          confirm_count: 1,
          confirm_text: null,
        }),
      ),
    )
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('two projects ask for DELETE, and the button stays shut until it is typed', async () => {
    serve()
    render(<StorageTab />)
    await pick('Big Campaign', 'Small Teaser')
    fireEvent.click(screen.getByRole('button', { name: /Delete 2/ }))
    await screen.findByLabelText(/type DELETE/i)
    const confirm = screen.getByRole('button', { name: 'Delete' })
    expect(confirm).toBeDisabled()
    await type('delete')
    expect(confirm).toBeDisabled() // the phrase, and its case, both count
    await type('DELETE')
    expect(confirm).toBeEnabled()
    fireEvent.click(confirm)
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        '/admin/delete',
        expect.objectContaining({ confirm_count: 2, confirm_text: 'DELETE' }),
      ),
    )
  })

  it.each([
    {
      what: 'more than one project',
      pickNames: ['Big Campaign', 'Small Teaser'],
      storage: overview(),
      prompt: 'More than one project: type DELETE to confirm.',
    },
    {
      what: 'one project over ten gigabytes',
      pickNames: ['Huge'],
      storage: overview({ project_count: 1, projects: [{ project_id: 'p-one', name: 'Huge', total_bytes: 11 * GB }] }),
      prompt: 'More than 10 GB: type DELETE to confirm.',
    },
  ])('names the threshold that actually tripped: $what', async ({ pickNames, storage, prompt }) => {
    // One sentence for both read "More than one project" on a single 200 GB
    // project, which is the kind of small lie that stops people reading dialogs.
    serve({ storage })
    render(<StorageTab />)
    await pick(...pickNames)
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`Delete ${pickNames.length}`) }))
    expect(await screen.findByLabelText(/type DELETE/i)).toBeInTheDocument()
    expect(screen.getByText(prompt)).toBeInTheDocument()
  })

  it('keeps the dialog open and shows the refusal the server sent', async () => {
    serve()
    post.mockRejectedValue(new Error('Confirmation is for 2 items but 1 are selected.'))
    render(<StorageTab />)
    await pick('Big Campaign')
    fireEvent.click(screen.getByRole('button', { name: /Delete 1/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))
    expect(
      await screen.findByText('Confirmation is for 2 items but 1 are selected.'),
    ).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('sends an older version on its own, and holds the newest shut until its file is picked', async () => {
    // Taking the current cut off a storage list would quietly demote the file
    // to an older one, so the box is disabled rather than failing at the server.
    serve()
    render(<StorageTab />)
    fireEvent.click(await screen.findByRole('button', { expanded: false, name: /Big Campaign/ }))
    fireEvent.click(await screen.findByRole('button', { expanded: false, name: /Hero Cut/ }))
    const newest = await screen.findByRole('checkbox', {
      name: 'Select version 3 of Hero Cut.mov',
    })
    expect(newest).toBeDisabled()
    expect(screen.getByText(/newest, only deletable with the whole file/)).toBeInTheDocument()
    await pick('version 1 of Hero Cut.mov')
    fireEvent.click(screen.getByRole('button', { name: /Delete 1/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        '/admin/delete',
        expect.objectContaining({ version_ids: ['v-1'], confirm_count: 1 }),
      ),
    )
    await pick('Hero Cut.mov')
    expect(newest).toBeChecked()
    expect(screen.queryByText(/only deletable with the whole file/)).not.toBeInTheDocument()
  })
})

// ── the trash ─────────────────────────────────────────────────────────────────

describe('the trash', () => {
  beforeEach(() => {
    serve({
      bin: FULL_BIN,
      storage: overview({ summary: summary({ trash_bytes: 2 * GB }) }),
    })
  })

  it('opens from the one small line, lists what is in it, and restores an entry', async () => {
    render(<StorageTab />)
    await openTrash()

    // By title, not by text: the name also appears as the parent of the asset
    // below it, and only the entry's own cell carries the title attribute.
    const reel = (await screen.findByTitle('Last Year Reel')).closest('tr')!
    expect(within(reel).getByText('28 days left')).toBeInTheDocument()
    const master = screen.getByText('Old Master.mov').closest('tr')!
    expect(within(master).getByText('12 days left')).toBeInTheDocument()
    fireEvent.click(within(reel).getByRole('button', { name: 'Restore' }))
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/admin/trash/restore', { project_ids: ['p-gone'] }),
    )
    expect(post).toHaveBeenCalledTimes(1)

    // And the one small line switches back to the storage list.
    fireEvent.click(await screen.findByRole('button', { name: /Back to storage/ }))
    expect(await screen.findByText('Big Campaign')).toBeInTheDocument()
  })

  it('says in the row why a child cannot be restored, not only on hover', async () => {
    // The reason was in a title attribute, which is nothing at all on a touch
    // screen and nothing to a glance. A child of a trashed project also gets no
    // permanent delete: its bytes are the project's, and purging it alone would
    // leave the project row quoting a figure it no longer holds.
    render(<StorageTab />)
    await openTrash()
    const row = (await screen.findByText('Stuck.mov')).closest('tr')!
    expect(within(row).getByText(/Restore the project above it first/)).toBeInTheDocument()
    expect(within(row).getByRole('button', { name: 'Restore' })).toBeDisabled()
    expect(within(row).queryByRole('button', { name: 'Delete permanently' })).toBeNull()
  })

  it.each([
    { what: 'a project', find: () => screen.findByTitle('Last Year Reel'), size: '1.5 GB', sent: { project_ids: ['p-gone'], confirm_bytes: 1.5 * GB } },
    { what: 'an asset', find: () => screen.findByText('Old Master.mov'), size: '512 MB', sent: { asset_ids: ['a-gone'], confirm_bytes: 0.5 * GB } },
  ])('offers $what its own permanent delete, with its own size', async ({ find, size, sent }) => {
    render(<StorageTab />)
    await openTrash()
    const row = (await find()).closest('tr')!
    expect(within(row).getByText(size)).toBeInTheDocument()
    fireEvent.click(within(row).getByRole('button', { name: 'Delete permanently' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/cannot be undone/)).toBeInTheDocument()
    const confirm = within(dialog).getByRole('button', { name: 'Delete permanently' })
    // Typed at every size, unlike the soft delete: nothing here comes back.
    expect(confirm).toBeDisabled()
    await type('DELETE')
    expect(confirm).toBeEnabled()
    fireEvent.click(confirm)
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/admin/trash/purge', {
        ...sent,
        confirm_count: 1,
        confirm_text: 'DELETE',
      }),
    )
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('still empties the whole trash in one go, sending both figures back', async () => {
    // So the server can refuse a stale page: that is what makes the number in
    // the dialog a promise rather than a decoration.
    render(<StorageTab />)
    await openTrash()
    fireEvent.click(await screen.findByRole('button', { name: /Empty trash \(2 GB\)/ }))
    expect(await screen.findByText(/cannot be undone/)).toBeInTheDocument()
    const confirm = screen.getByRole('button', { name: 'Delete permanently' })
    expect(confirm).toBeDisabled()
    await type('DELETE')
    expect(confirm).toBeEnabled()
    fireEvent.click(confirm)
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/admin/trash/purge', {
        everything: true,
        confirm_count: 3,
        confirm_bytes: 2 * GB,
        confirm_text: 'DELETE',
      }),
    )
  })
})
