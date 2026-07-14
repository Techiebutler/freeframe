import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { CompareVersionSelect } from '../compare-version-select'
import type { AssetVersion } from '@/types'

function makeVersion(partial: Partial<AssetVersion>): AssetVersion {
  return {
    id: 'v-' + (partial.version_number ?? 1),
    asset_id: 'a1',
    version_number: 1,
    processing_status: 'ready',
    created_at: new Date().toISOString(),
    ...partial,
  } as AssetVersion
}

describe('CompareVersionSelect', () => {
  const v1 = makeVersion({ id: 'v-1', version_number: 1 })
  const v2 = makeVersion({ id: 'v-2', version_number: 2, processing_status: 'processing' })
  const v3 = makeVersion({ id: 'v-3', version_number: 3 })

  it('shows the selected label and lists versions ascending', () => {
    render(
      <CompareVersionSelect versions={[v3, v1, v2]} value="v-3" onChange={vi.fn()} accentClass="text-accent" />,
    )
    expect(screen.getByRole('button', { name: /v3/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /v3/ }))
    const items = screen.getAllByRole('option')
    expect(items.map((i) => i.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining('v1'), expect.stringContaining('v2'), expect.stringContaining('v3')]),
    )
  })

  it('selects a ready version and closes', () => {
    const onChange = vi.fn()
    render(<CompareVersionSelect versions={[v1, v3]} value="v-1" onChange={onChange} accentClass="text-accent" />)
    fireEvent.click(screen.getByRole('button', { name: /v1/ }))
    fireEvent.click(screen.getByRole('option', { name: /v3/ }))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ id: 'v-3' }))
  })

  it('disables non-ready versions', () => {
    const onChange = vi.fn()
    render(<CompareVersionSelect versions={[v1, v2]} value="v-1" onChange={onChange} accentClass="text-accent" />)
    fireEvent.click(screen.getByRole('button', { name: /v1/ }))
    const processing = screen.getByRole('option', { name: /v2/ })
    expect(processing).toBeDisabled()
    fireEvent.click(processing)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('disables the version shown on the other pane (excludeId) so both sides differ', () => {
    const onChange = vi.fn()
    render(<CompareVersionSelect versions={[v1, v3]} value="v-1" excludeId="v-3" onChange={onChange} accentClass="text-accent" />)
    fireEvent.click(screen.getByRole('button', { name: /v1/ }))
    const other = screen.getByRole('option', { name: /v3/ })
    expect(other).toBeDisabled()
    fireEvent.click(other)
    expect(onChange).not.toHaveBeenCalled()
  })
})
