import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { VersionSwitcher } from '../version-switcher'
import { useReviewStore } from '@/stores/review-store'
import type { AssetVersion } from '@/types'

function makeVersion(partial: Partial<AssetVersion> & { version_number: number }): AssetVersion {
  return {
    id: `v${partial.version_number}`,
    asset_id: 'asset-1',
    processing_status: 'ready',
    created_by: 'user-1',
    created_at: '',
    deleted_at: null,
    files: [],
    ...partial,
  } as AssetVersion
}

describe('VersionSwitcher trigger status indicator (#118)', () => {
  beforeEach(() => {
    useReviewStore.getState().reset()
  })

  it('shows a processing indicator on the always-visible trigger when the newest version is still processing', () => {
    const v1 = makeVersion({ version_number: 1, processing_status: 'ready' })
    const v2 = makeVersion({ version_number: 2, processing_status: 'processing' })
    // Viewer is still on the ready v1 while v2 transcodes.
    useReviewStore.getState().setCurrentVersion(v1)

    render(<VersionSwitcher versions={[v1, v2]} />)

    // Trigger reflects the currently-viewed version...
    expect(screen.getByText('v1')).toBeInTheDocument()
    // ...and surfaces that a newer version is being processed, without opening the dropdown.
    expect(screen.getByTestId('version-status-indicator')).toBeInTheDocument()
    expect(screen.getByTestId('version-status-indicator')).toHaveTextContent(/processing/i)
  })

  it('shows an uploading indicator while the newest version is uploading', () => {
    const v1 = makeVersion({ version_number: 1, processing_status: 'ready' })
    const v2 = makeVersion({ version_number: 2, processing_status: 'uploading' })
    useReviewStore.getState().setCurrentVersion(v1)

    render(<VersionSwitcher versions={[v1, v2]} />)

    expect(screen.getByTestId('version-status-indicator')).toHaveTextContent(/uploading/i)
  })

  it('shows no processing indicator when every version is ready', () => {
    const v1 = makeVersion({ version_number: 1, processing_status: 'ready' })
    const v2 = makeVersion({ version_number: 2, processing_status: 'ready' })
    useReviewStore.getState().setCurrentVersion(v2)

    render(<VersionSwitcher versions={[v1, v2]} />)

    expect(screen.queryByTestId('version-status-indicator')).toBeNull()
  })
})
