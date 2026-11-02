import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { SWRConfig } from 'swr'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PartsWorkspace } from '../parts-workspace'
import { declareParts, requestIterations, submitParts, type IterationProgress } from '@/lib/iterations'
import { uploadToRequest } from '@/lib/platform'
vi.mock('@/lib/iterations', async original => ({ ...await original<typeof import('@/lib/iterations')>(), declareParts: vi.fn(), requestIterations: vi.fn(), submitParts: vi.fn() }))
vi.mock('@/lib/platform', async original => ({ ...await original<typeof import('@/lib/platform')>(), uploadToRequest: vi.fn() }))
vi.mock('../request-workspace', () => ({ RequestWorkspace: () => <div>Part feedback</div> }))
vi.mock('lucide-react', async original => ({
  ...await original<typeof import('lucide-react')>(),
  AlertCircle: () => <svg aria-hidden="true" data-testid="attention-icon" />,
  CheckCircle2: () => <svg aria-hidden="true" data-testid="completion-icon" />,
}))
const base: IterationProgress = { enabled: true, mode: 'components', simple: true, manifest: { schema_version: 1, summary: '', slots: [], recipes: [] }, slots: [], outputs: [], state: 'waiting', delivered: 0, total: 0, submitted: false, can_leave: false, editor_done: false }
beforeEach(() => { vi.resetAllMocks(); localStorage.clear(); vi.mocked(requestIterations).mockResolvedValue(base); vi.mocked(declareParts).mockResolvedValue(base) })
afterEach(cleanup)
const mount = () => render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}><PartsWorkspace token="test" who={{ name: 'Fred', email: 'fred@example.test' }} /></SWRConfig>)
it('declares roles before starting upload on drop; does not submit the batch automatically', async () => {
  vi.mocked(uploadToRequest).mockResolvedValue({ asset_id: 'h1', version_number: 1 })
  const view = mount()
  const zone = await screen.findByLabelText('Upload hooks')
  fireEvent.change(zone, { target: { files: [new File(['a'], 'hook.mp4', { type: 'video/mp4' })] } })
  await waitFor(() => expect(uploadToRequest).toHaveBeenCalled())
  expect(declareParts).toHaveBeenCalledWith('test', [expect.objectContaining({ role: 'hook', label: 'hook.mp4' })])
  expect(vi.mocked(declareParts).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(uploadToRequest).mock.invocationCallOrder[0])
  expect(uploadToRequest).toHaveBeenCalledWith('test', expect.objectContaining({ name: 'Fred' }), expect.any(File), expect.any(Function), expect.objectContaining({ slotId: expect.any(String) }))
  expect(submitParts).not.toHaveBeenCalled()
  view.unmount()
})
it('keeps the browser-open message and submit disabled during transfers even if server previously allowed leaving', async () => {
  vi.mocked(uploadToRequest).mockReturnValue(new Promise(() => {}))
  mount()
  fireEvent.change(await screen.findByLabelText('Upload bodies'), { target: { files: [new File(['b'], 'body.mp4', { type: 'video/mp4' })] } })
  expect(await screen.findByText('Keep this tab open until all files are saved.')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Submit for review' })).toBeDisabled()
})
it('restores truthful background handoff state when reopening a submitted link', async () => {
  vi.mocked(requestIterations).mockResolvedValue({ ...base, submitted: true, can_leave: true, editor_done: true, state: 'rendering', total: 8, delivered: 6 })
  mount()
  expect(await screen.findByText('Your part is done')).toBeInTheDocument()
  expect(screen.queryByText('8 ads delivered')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Submit for review' })).not.toBeInTheDocument()
})
it('accepts signed-in identity that arrives after mount, including an in-flight upload', async () => {
  const provider = new Map()
  vi.mocked(uploadToRequest).mockImplementation(async (_token, _who, _file, _progress, options) => {
    const identity = await options!.identity!()
    expect(identity.email).toBe('fred@example.test')
    return { asset_id: 'h1', version_number: 1 }
  })
  const view = render(<SWRConfig value={{ provider: () => provider }}><PartsWorkspace token="test" /></SWRConfig>)
  fireEvent.change(await screen.findByLabelText('Upload hooks'), { target: { files: [new File(['a'], 'hook.mp4', { type: 'video/mp4' })] } })
  await waitFor(() => expect(uploadToRequest).toHaveBeenCalled())
  view.rerender(<SWRConfig value={{ provider: () => provider }}><PartsWorkspace token="test" who={{ name: 'Fred', email: 'fred@example.test' }} /></SWRConfig>)
  await waitFor(() => expect(screen.queryByText('Keep this tab open until all files are saved.')).not.toBeInTheDocument())
})
it('does not let parts waiting for contact details hold back the rest of the drop', async () => {
  const started: string[] = []
  vi.mocked(uploadToRequest).mockImplementation(async (_token, _who, file, _progress, options) => {
    started.push(file.name)
    options!.onTransferred!()
    await options!.identity!()
    return { asset_id: file.name, version_number: 1 }
  })
  render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}><PartsWorkspace token="test" /></SWRConfig>)
  const names = ['h1.mp4', 'h2.mp4', 'h3.mp4', 'h4.mp4']
  fireEvent.change(await screen.findByLabelText('Upload hooks'), { target: { files: names.map(name => new File(['a'], name, { type: 'video/mp4' })) } })
  await waitFor(() => expect(started).toEqual(names))
})
const saved: IterationProgress = { ...base, total: 1, manifest: { ...base.manifest, slots: [{ id: 'h', label: 'Hook.mp4', role: 'hook', group: '', script: '' }, { id: 'b', label: 'Body.mp4', role: 'body', group: '', script: '' }] }, slots: [{ slot_id: 'h', asset_id: 'ha', version_id: 'hv', version_number: 1, status: 'clear', findings: [], bytes_stored: true }, { slot_id: 'b', asset_id: 'ba', version_id: 'bv', version_number: 1, status: 'reviewing', findings: [], bytes_stored: true }] }
it('seals the complete saved batch explicitly and displays only the returned server handoff', async () => {
  vi.mocked(requestIterations).mockResolvedValue(saved)
  vi.mocked(submitParts).mockResolvedValue({ ...saved, submitted: true, can_leave: true, editor_done: false })
  mount()
  fireEvent.click(await screen.findByRole('button', { name: 'Submit for review' }))
  await waitFor(() => expect(submitParts).toHaveBeenCalledWith('test'))
  expect(await screen.findByText('Submitted · checking your parts')).toBeInTheDocument()
  expect(screen.queryByText('Your part is done')).not.toBeInTheDocument()
})
it('does not seal after reload when a bound version still has unsaved bytes', async () => {
  vi.mocked(requestIterations).mockResolvedValue({ ...saved, slots: saved.slots.map(s => ({ ...s, bytes_stored: false })) })
  mount()
  expect(await screen.findByRole('button', { name: 'Submit for review' })).toBeDisabled()
})
it('replaces the selected part using its exact asset binding instead of declaring another part', async () => {
  vi.mocked(requestIterations).mockResolvedValue({ ...saved, submitted: true, state: 'held' })
  vi.mocked(uploadToRequest).mockReturnValue(new Promise(() => {}))
  mount()
  fireEvent.change(await screen.findByLabelText('Replace Hook.mp4'), { target: { files: [new File(['v2'], 'Different filename.mp4', { type: 'video/mp4' })] } })
  await waitFor(() => expect(uploadToRequest).toHaveBeenCalledWith('test', expect.any(Object), expect.any(File), expect.any(Function), expect.objectContaining({ slotId: 'h', assetId: 'ha' })))
  expect(declareParts).not.toHaveBeenCalled()
  expect(screen.queryByText('Your part is done')).not.toBeInTheDocument()
})

const stages = async () => within(await screen.findByRole('list', { name: 'Submission progress' })).getAllByRole('listitem')
const checkedParts = saved.slots.map(part => ({ ...part, status: 'clear' }))

it('keeps upload current without showing an empty output region before any part is declared', async () => {
  mount()
  const steps = await stages()
  expect(steps).toHaveLength(3)
  expect(steps[0]).toHaveAttribute('aria-current', 'step')
  expect(steps.every(step => !step.textContent?.includes('Complete'))).toBe(true)
  expect(screen.queryByRole('region', { name: 'Final ads' })).not.toBeInTheDocument()
})

it('shows review and download for a generated ad instead of hiding the completed result', async () => {
  vi.mocked(requestIterations).mockResolvedValue({ ...saved, submitted: true, outputs: [{ id: 'out', label: 'Hook + Body', status: 'delivered', asset_id: 'oa', version_id: 'ov', download_url: 'https://media.example.test/ad.mp4', findings: [] }] })
  mount()
  const results = within(await screen.findByRole('region', { name: 'Final ads' }))
  expect(results.getByRole('link', { name: 'Download' })).toHaveAttribute('href', 'https://media.example.test/ad.mp4')
  fireEvent.click(results.getByRole('button', { name: 'View final review' }))
  expect(await screen.findByText('Part feedback')).toBeInTheDocument()
})

it('shows an output failure even when rendering could not produce an asset', async () => {
  vi.mocked(requestIterations).mockResolvedValue({ ...saved, submitted: true, state: 'error', outputs: [{ id: 'failed', label: 'Hook + Body', status: 'error', error: 'Render service unavailable', findings: [] }] })
  mount()
  expect(await screen.findByText('Render service unavailable')).toBeVisible()
  expect(screen.getByRole('button', { name: 'Retry processing' })).toBeVisible()
})

it('keeps uploading current until explicit submission even when every source check is clear', async () => {
  vi.mocked(requestIterations).mockResolvedValue({ ...saved, slots: checkedParts })
  mount()
  const steps = await stages()
  expect(steps[0]).toHaveAttribute('aria-current', 'step')
  expect(steps[0]).not.toHaveTextContent('Complete')
  expect(steps[1]).toHaveTextContent('2 of 2 parts passed')
  expect(steps[2]).not.toHaveTextContent('Complete')
  expect(screen.getByRole('button', { name: 'Submit for review' })).toBeEnabled()
})

it('counts only declared parts with an explicit clear state', async () => {
  vi.mocked(requestIterations).mockResolvedValue({ ...saved, submitted: true, can_leave: true, slots: [
    saved.slots[0],
    { ...saved.slots[1], status: 'ready' },
    { slot_id: 'unrelated', status: 'clear', findings: [], bytes_stored: true },
  ] })
  mount()
  const steps = await stages()
  expect(steps[0]).toHaveTextContent('Complete')
  expect(steps[1]).toHaveAttribute('aria-current', 'step')
  expect(steps[1]).toHaveTextContent('1 of 2 parts passed')
  expect(steps[1]).not.toHaveTextContent('Complete')
})

it.each([
  { state: 'rendering', delivered: 1 },
  { state: 'delivered', delivered: 1 },
  { state: 'reviewing', delivered: 2 },
])('does not complete final ads for state $state and $delivered of 2 delivered', async snapshot => {
  vi.mocked(requestIterations).mockResolvedValue({ ...saved, ...snapshot, slots: checkedParts, submitted: true, can_leave: true, editor_done: true, total: 2 })
  mount()
  const steps = await stages()
  expect(steps[2]).toHaveAttribute('aria-current', 'step')
  expect(steps[2]).not.toHaveTextContent('Complete')
  expect(screen.queryByText('2 ads delivered')).not.toBeInTheDocument()
})

it('completes all stages only after the exact final batch is delivered', async () => {
  vi.mocked(requestIterations).mockResolvedValue({ ...saved, slots: checkedParts, submitted: true, can_leave: true, editor_done: true, state: 'delivered', total: 2, delivered: 2 })
  mount()
  const steps = await stages()
  expect(steps.every(step => step.textContent?.includes('Complete'))).toBe(true)
  expect(steps.every(step => !step.hasAttribute('aria-current'))).toBe(true)
  expect(screen.getByText('2 ads delivered')).toBeInTheDocument()
})

it('does not complete stages when a delivered snapshot arrives during replacement upload', async () => {
  vi.mocked(requestIterations)
    .mockResolvedValueOnce({ ...saved, slots: checkedParts, submitted: true, can_leave: true, editor_done: true, state: 'held', total: 2 })
    .mockResolvedValue({ ...saved, slots: checkedParts, submitted: true, can_leave: true, editor_done: true, state: 'delivered', total: 2, delivered: 2 })
  vi.mocked(uploadToRequest).mockReturnValue(new Promise(() => {}))
  mount()
  fireEvent.change(await screen.findByLabelText('Replace Hook.mp4'), { target: { files: [new File(['v2'], 'Hook-v2.mp4', { type: 'video/mp4' })] } })
  expect(await screen.findByText('Keep this tab open until all files are saved.')).toBeInTheDocument()
  const steps = await stages()
  await waitFor(() => expect(steps[2]).toHaveTextContent('2 of 2 ads delivered'), { timeout: 6000 })
  expect(steps[0]).toHaveAttribute('aria-current', 'step')
  expect(steps.every(step => !step.textContent?.includes('Complete'))).toBe(true)
  expect(screen.queryByText('2 ads delivered')).not.toBeInTheDocument()
}, 10000)

it.each([
  { state: 'held', title: 'A part needs your attention' },
  { state: 'error', title: 'We need to retry a step' },
])('shows attention rather than completion for $state even when the editor handoff is done', async snapshot => {
  vi.mocked(requestIterations).mockResolvedValue({ ...saved, state: snapshot.state, slots: checkedParts, submitted: true, can_leave: true, editor_done: true })
  mount()
  expect(await screen.findByText(snapshot.title)).toBeInTheDocument()
  const status = within(screen.getByRole('status'))
  expect(status.getByTestId('attention-icon')).toBeInTheDocument()
  expect(status.queryByTestId('completion-icon')).not.toBeInTheDocument()
  expect(screen.queryByText('Your part is done')).not.toBeInTheDocument()
  const steps = await stages()
  expect(steps[2]).not.toHaveTextContent('Complete')
  if (snapshot.state === 'error') expect(screen.getByRole('button', { name: 'Retry processing' })).toBeInTheDocument()
})

const mountGuest = () => render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}><PartsWorkspace token="test" /></SWRConfig>)
it('saves current guest contact when submitting without a separate save action', async () => {
  vi.mocked(requestIterations).mockResolvedValue(saved)
  vi.mocked(submitParts).mockResolvedValue({ ...saved, submitted: true, can_leave: true })
  mountGuest()
  fireEvent.change(await screen.findByLabelText('Your name'), { target: { value: ' Fred ' } })
  fireEvent.change(screen.getByLabelText('Your email'), { target: { value: 'fred@example.test' } })
  fireEvent.click(screen.getByRole('button', { name: 'Submit for review' }))
  expect(await screen.findByText('Submitted · checking your parts')).toBeInTheDocument()
  expect(JSON.parse(localStorage.getItem('aditor-request-who')!)).toEqual({ name: 'Fred', email: 'fred@example.test' })
})

it.each(['blur', 'Enter'])('resumes an upload waiting for valid guest contact on %s and keeps contact editable', async action => {
  let uploadedWho: unknown
  vi.mocked(uploadToRequest).mockImplementation(async (_token, _who, _file, _progress, options) => {
    uploadedWho = await options!.identity!()
    return { asset_id: 'ha', version_number: 1 }
  })
  mountGuest()
  fireEvent.change(await screen.findByLabelText('Upload hooks'), { target: { files: [new File(['a'], 'hook.mp4', { type: 'video/mp4' })] } })
  await waitFor(() => expect(uploadToRequest).toHaveBeenCalled())
  fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Fred' } })
  fireEvent.change(screen.getByLabelText('Your email'), { target: { value: 'invalid' } })
  if (action === 'blur') fireEvent.blur(screen.getByLabelText('Your email'))
  else fireEvent.keyDown(screen.getByLabelText('Your email'), { key: 'Enter' })
  expect(uploadedWho).toBeUndefined()
  fireEvent.change(screen.getByLabelText('Your email'), { target: { value: 'fred@example.test' } })
  if (action === 'blur') fireEvent.blur(screen.getByLabelText('Your email'))
  else fireEvent.keyDown(screen.getByLabelText('Your email'), { key: 'Enter' })
  await waitFor(() => expect(uploadedWho).toEqual({ name: 'Fred', email: 'fred@example.test' }))
  expect(screen.getByLabelText('Your email')).toHaveValue('fred@example.test')
})

it('requires valid guest contact before sealing a restored saved batch', async () => {
  vi.mocked(requestIterations).mockResolvedValue(saved)
  mountGuest()
  expect(await screen.findByRole('button', { name: 'Submit for review' })).toBeDisabled()
  fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Fred' } })
  fireEvent.change(screen.getByLabelText('Your email'), { target: { value: 'invalid' } })
  expect(screen.getByRole('button', { name: 'Submit for review' })).toBeDisabled()
})
it('removes an added lead or CTA step again while it holds no parts', async () => {
  mount()
  fireEvent.click(await screen.findByRole('button', { name: 'Add leads' }))
  expect(await screen.findByLabelText('Upload leads')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Remove leads' }))
  expect(screen.queryByLabelText('Upload leads')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Add leads' })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Add separate CTAs' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Remove separate CTAs' }))
  expect(screen.queryByLabelText('Upload ctas')).not.toBeInTheDocument()
})
